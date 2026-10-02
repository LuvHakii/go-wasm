package jsonrpc2

import (
	"context"
	"encoding/json"
	"os"

	"golang.org/x/tools/internal/browserhost"
)

type browserStream struct{ in *json.Decoder }

func NewBrowserStream() Stream {
	return &browserStream{in: json.NewDecoder(os.Stdin)}
}

func (s *browserStream) Read(ctx context.Context) (Message, int64, error) {
	if err := ctx.Err(); err != nil {
		return nil, 0, err
	}
	var raw json.RawMessage
	if err := s.in.Decode(&raw); err != nil {
		return nil, 0, err
	}
	msg, err := DecodeMessage(raw)
	return msg, int64(len(raw)), err
}

func (s *browserStream) Write(ctx context.Context, msg Message) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return 0, err
	}
	browserhost.SendMessage(data)
	return int64(len(data)), nil
}

func (s *browserStream) Close() error { return os.Stdin.Close() }
