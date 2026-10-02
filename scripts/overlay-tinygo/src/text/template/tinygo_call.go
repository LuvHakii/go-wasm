package template

import (
	"fmt"
	"reflect"
	"text/template/parse"
)

type tfn struct {
	in       []reflect.Type
	variadic bool
	call     func(args []reflect.Value) (reflect.Value, error)
}

var (
	valuesType = reflect.TypeFor[[]reflect.Value]()
	anysType   = reflect.TypeFor[[]any]()
	stringType = reflect.TypeFor[string]()
	intType    = reflect.TypeFor[int]()
	stringsTyp = reflect.TypeFor[[]string]()
)

func argAs[T any](v reflect.Value) T {
	var zero T
	if !v.IsValid() {
		return zero
	}
	x, ok := v.Interface().(T)
	if !ok {
		return zero
	}
	return x
}

func valuesOf(args []reflect.Value) []reflect.Value {
	out := make([]reflect.Value, len(args))
	for i, a := range args {
		out[i] = argAs[reflect.Value](a)
	}
	return out
}

func anysOf(args []reflect.Value) []any {
	out := make([]any, len(args))
	for i, a := range args {
		if a.IsValid() {
			out[i] = a.Interface()
		}
	}
	return out
}

func Fn0[R any](f func() R) any {
	return &tfn{call: func([]reflect.Value) (reflect.Value, error) { return reflect.ValueOf(f()), nil }}
}

func Fn1[A, R any](f func(A) R) any {
	return &tfn{in: []reflect.Type{reflect.TypeFor[A]()}, call: func(a []reflect.Value) (reflect.Value, error) {
		return reflect.ValueOf(f(argAs[A](a[0]))), nil
	}}
}

func sigOf(fn any) *tfn {
	switch f := fn.(type) {
	case *tfn:
		return f
	case func([]string, string) string:
		return &tfn{in: []reflect.Type{stringsTyp, stringType}, call: func(a []reflect.Value) (reflect.Value, error) {
			return reflect.ValueOf(f(argAs[[]string](a[0]), argAs[string](a[1]))), nil
		}}
	case func() any:
		return &tfn{call: func([]reflect.Value) (reflect.Value, error) { return reflect.ValueOf(f()), nil }}
	case func(int) int:
		return &tfn{in: []reflect.Type{intType}, call: func(a []reflect.Value) (reflect.Value, error) {
			return reflect.ValueOf(f(argAs[int](a[0]))), nil
		}}
	case func(int, int) int:
		return &tfn{in: []reflect.Type{intType, intType}, call: func(a []reflect.Value) (reflect.Value, error) {
			return reflect.ValueOf(f(argAs[int](a[0]), argAs[int](a[1]))), nil
		}}
	case func(...any) string:
		return &tfn{in: []reflect.Type{anysType}, variadic: true, call: func(a []reflect.Value) (reflect.Value, error) {
			return reflect.ValueOf(f(anysOf(a)...)), nil
		}}
	case func(string, ...any) string:
		return &tfn{in: []reflect.Type{stringType, anysType}, variadic: true, call: func(a []reflect.Value) (reflect.Value, error) {
			return reflect.ValueOf(f(argAs[string](a[0]), anysOf(a[1:])...)), nil
		}}
	case func(reflect.Value, ...reflect.Value) reflect.Value:
		return &tfn{in: []reflect.Type{reflectValueType, valuesType}, variadic: true}
	case func(reflect.Value, ...reflect.Value) (reflect.Value, error):
		return &tfn{in: []reflect.Type{reflectValueType, valuesType}, variadic: true, call: func(a []reflect.Value) (reflect.Value, error) {
			v, err := f(argAs[reflect.Value](a[0]), valuesOf(a[1:])...)
			return reflect.ValueOf(v), err
		}}
	case func(reflect.Value) (int, error):
		return &tfn{in: []reflect.Type{reflectValueType}, call: func(a []reflect.Value) (reflect.Value, error) {
			n, err := f(argAs[reflect.Value](a[0]))
			return reflect.ValueOf(n), err
		}}
	case func(reflect.Value) bool:
		return &tfn{in: []reflect.Type{reflectValueType}, call: func(a []reflect.Value) (reflect.Value, error) {
			return reflect.ValueOf(f(argAs[reflect.Value](a[0]))), nil
		}}
	case func(reflect.Value, ...reflect.Value) (bool, error):
		return &tfn{in: []reflect.Type{reflectValueType, valuesType}, variadic: true, call: func(a []reflect.Value) (reflect.Value, error) {
			b, err := f(argAs[reflect.Value](a[0]), valuesOf(a[1:])...)
			return reflect.ValueOf(b), err
		}}
	case func(reflect.Value, reflect.Value) (bool, error):
		return &tfn{in: []reflect.Type{reflectValueType, reflectValueType}, call: func(a []reflect.Value) (reflect.Value, error) {
			b, err := f(argAs[reflect.Value](a[0]), argAs[reflect.Value](a[1]))
			return reflect.ValueOf(b), err
		}}
	}
	return nil
}

func addValueFuncsSig(out map[string]reflect.Value, in FuncMap) {
	for name, fn := range in {
		if !goodName(name) {
			panic(fmt.Errorf("function name %q is not a valid identifier", name))
		}
		sig := sigOf(fn)
		if sig == nil {
			sig = &tfn{in: []reflect.Type{anysType}, variadic: true, call: func([]reflect.Value) (reflect.Value, error) {
				return reflect.Value{}, fmt.Errorf("function %s has a signature this build cannot call", name)
			}}
		}
		out[name] = reflect.ValueOf(sig)
	}
}

func safeCallSig(sig *tfn, args []reflect.Value) (val reflect.Value, err error) {
	defer func() {
		if r := recover(); r != nil {
			if e, ok := r.(error); ok {
				err = e
			} else {
				err = fmt.Errorf("%v", r)
			}
		}
	}()
	return sig.call(args)
}

func (s *state) evalCallSig(dot, fun reflect.Value, isBuiltin bool, node parse.Node, name string, args []parse.Node, final reflect.Value) reflect.Value {
	if args != nil {
		args = args[1:]
	}
	sig, ok := fun.Interface().(*tfn)
	if !ok {
		s.errorf("%s cannot be called in this build", name)
	}
	numIn := len(args)
	if !isMissing(final) {
		numIn++
	}
	numFixed := len(args)
	if sig.variadic {
		numFixed = len(sig.in) - 1
		if numIn < numFixed {
			s.errorf("wrong number of args for %s: want at least %d got %d", name, len(sig.in)-1, len(args))
		}
	} else if numIn != len(sig.in) {
		s.errorf("wrong number of args for %s: want %d got %d", name, len(sig.in), numIn)
	}

	unwrap := func(v reflect.Value) reflect.Value {
		if v.Type() == reflectValueType {
			v = v.Interface().(reflect.Value)
		}
		return v
	}

	if isBuiltin && (name == "and" || name == "or") {
		argType := sig.in[0]
		var v reflect.Value
		for _, arg := range args {
			v = s.evalArg(dot, argType, arg).Interface().(reflect.Value)
			if truth(v) == (name == "or") {
				return v
			}
		}
		if !final.Equal(missingVal) {
			v = unwrap(s.validateType(final, argType))
		}
		return v
	}
	if isBuiltin && name == "call" {
		s.errorf("call is not supported in this build")
	}

	argv := make([]reflect.Value, numIn)
	i := 0
	for ; i < numFixed && i < len(args); i++ {
		argv[i] = s.evalArg(dot, sig.in[i], args[i])
	}
	if sig.variadic {
		argType := sig.in[len(sig.in)-1].Elem()
		for ; i < len(args); i++ {
			argv[i] = s.evalArg(dot, argType, args[i])
		}
	}
	if !isMissing(final) {
		t := sig.in[len(sig.in)-1]
		if sig.variadic {
			if numIn-1 < numFixed {
				t = sig.in[numIn-1]
			} else {
				t = t.Elem()
			}
		}
		argv[i] = s.validateType(final, t)
	}

	v, err := safeCallSig(sig, argv)
	if err != nil {
		s.at(node)
		s.errorf("error calling %s: %w", name, err)
	}
	return unwrap(v)
}
