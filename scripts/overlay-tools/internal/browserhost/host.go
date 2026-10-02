package browserhost

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"runtime"
	"unsafe"
)

type Command struct {
	Argv []string `json:"argv"`
	Env  []string `json:"env"`
	Cwd  string   `json:"cwd"`
}

type Result struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exitCode"`
}

//go:wasmimport browser command
func command(ptr unsafe.Pointer, length uint32) int32

//go:wasmimport browser message
func message(ptr unsafe.Pointer, length uint32)

func Run(ctx context.Context, request Command) (Result, error) {
	data, err := json.Marshal(request)
	if err != nil {
		return Result{}, err
	}
	fd := command(unsafe.Pointer(unsafe.SliceData(data)), uint32(len(data)))
	runtime.KeepAlive(data)
	if fd < 0 {
		return Result{}, fmt.Errorf("browser command rejected: %d", fd)
	}
	file := os.NewFile(uintptr(fd), "browser-command")
	defer file.Close()
	stop := context.AfterFunc(ctx, func() { file.Close() })
	defer stop()
	response, err := io.ReadAll(file)
	if ctx.Err() != nil {
		return Result{}, ctx.Err()
	}
	if err != nil {
		return Result{}, err
	}
	var result Result
	if err := json.Unmarshal(response, &result); err != nil {
		return Result{}, err
	}
	if result.ExitCode != 0 {
		return result, fmt.Errorf("browser command exited with status %d: %s", result.ExitCode, result.Stderr)
	}
	return result, nil
}

func SendMessage(data []byte) {
	if len(data) == 0 {
		return
	}
	message(unsafe.Pointer(unsafe.SliceData(data)), uint32(len(data)))
	runtime.KeepAlive(data)
}
