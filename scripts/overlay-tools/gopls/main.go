package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"

	"golang.org/x/tools/gopls/internal/cache"
	"golang.org/x/tools/gopls/internal/protocol"
	"golang.org/x/tools/gopls/internal/server"
	"golang.org/x/tools/gopls/internal/settings"
	"golang.org/x/tools/internal/jsonrpc2"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "version" {
		fmt.Println("golang.org/x/tools/gopls browser")
		return
	}
	if len(os.Args) > 2 || (len(os.Args) == 2 && os.Args[1] != "serve") {
		fmt.Fprintln(os.Stderr, "unsupported browser gopls command")
		os.Exit(2)
	}
	ctx := context.Background()
	conn := jsonrpc2.NewConn(jsonrpc2.NewBrowserStream())
	client := protocol.ClientDispatcher(conn)
	ctx = protocol.WithClient(ctx, client)
	session := cache.NewSession(ctx, cache.New(nil))
	svr := server.New(session, client, settings.DefaultOptions(nil))
	defer svr.Shutdown(ctx)
	conn.Go(ctx, protocol.Handlers(protocol.ServerHandler(svr, jsonrpc2.MethodNotFound)))
	<-conn.Done()
	if err := conn.Err(); err != nil && !errors.Is(err, io.EOF) {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
