//go:build wasip1

package main

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"golang.org/x/tools/internal/browserhost"
)

func main() {
	var ticks atomic.Int32
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		for {
			select {
			case <-ctx.Done(): return
			case <-time.After(5*time.Millisecond): ticks.Add(1)
			}
		}
	}()
	for _, input := range []string{"41", strings.Repeat("large-payload-", 10000), "last"} {
		result, err := browserhost.Run(ctx, browserhost.Command{Argv: []string{"probe", input}, Env: []string{}, Cwd: "/workspace"})
		if err != nil { panic(err) }
		want := fmt.Sprintf("%x", sha256.Sum256([]byte(input)))
		if result.Stdout != want { panic("bridge corrupted payload") }
		payload, err := os.ReadFile("/tmp/payload")
		if err != nil || string(payload) != input { panic("bridge corrupted multi-chunk file") }
	}
	if ticks.Load() < 3 { panic("scheduler stopped during command wait") }
	cancelCtx, stop := context.WithTimeout(ctx, 20*time.Millisecond)
	defer stop()
	if _, err := browserhost.Run(cancelCtx, browserhost.Command{Argv: []string{"never"}, Env: []string{}, Cwd: "/workspace"}); err == nil { panic("cancellation succeeded instead of failing") }
	fmt.Printf("bridge passed; scheduler ticks=%d\n", ticks.Load())
}
