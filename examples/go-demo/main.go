// Axiom Go runtime-layer spike target.
//
// Spawns several worker goroutines that each call processPayment, so the
// delve-based tracer can be tested for per-goroutine call attribution.
//
//	go run .            - run normally
//	(launched by Axiom via dlv dap for tracing)
package main

import (
	"fmt"
	"math/rand"
	"sync"
	"time"
)

func main() {
	fmt.Println("go-demo: starting payment workers")
	var wg sync.WaitGroup
	currencies := []string{"USD", "EUR", "GBP"}

	for worker := 0; worker < 4; worker++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for i := 0; i < 5; i++ {
				amount := rand.Float64()*500 + 5
				if rand.Float64() < 0.2 {
					amount = -amount
				}
				currency := currencies[rand.Intn(len(currencies))]
				result := processPayment(id, amount, currency)
				fmt.Printf("worker %d: %s\n", id, result)
				time.Sleep(300 * time.Millisecond)
			}
		}(worker)
	}
	wg.Wait()
	fmt.Println("go-demo: done")
}

// processPayment is the watched function. Each concurrent worker goroutine
// calls it, so hits on its breakpoint should attribute to different goroutines.
func processPayment(worker int, amount float64, currency string) string {
	if amount < 0 {
		return fmt.Sprintf("REJECTED amount=%.2f %s", amount, currency)
	}
	return fmt.Sprintf("OK amount=%.2f %s tx=%d", amount, currency, rand.Intn(100000))
}
