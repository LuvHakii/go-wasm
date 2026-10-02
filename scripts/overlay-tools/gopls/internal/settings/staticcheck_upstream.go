package settings

import (
	"sort"

	"honnef.co/go/tools/analysis/lint"
)

func saUpstream(config map[*lint.Analyzer]any) []*lint.Analyzer {
	res := make([]*lint.Analyzer, 0, len(config))
	for a := range config {
		if a.Analyzer.Name == "SA5011" {
			continue // configured here but not part of staticcheck.Analyzers
		}
		res = append(res, a)
	}
	sort.Slice(res, func(i, j int) bool { return res[i].Analyzer.Name < res[j].Analyzer.Name })
	return res
}
