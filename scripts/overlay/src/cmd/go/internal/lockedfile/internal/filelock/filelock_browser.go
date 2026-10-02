package filelock

import "errors"

type lockType int8

const (
	readLock = iota + 1
	writeLock
)

// The browser broker serializes writable cache access; locking succeeds only under that policy.
//
//go:wasmimport browser single_writer
func singleWriter() bool

func lock(f File, lt lockType) error {
	if !singleWriter() {
		return errors.New("browser cache requires a serialized writer")
	}
	return nil
}

func unlock(f File) error { return nil }
