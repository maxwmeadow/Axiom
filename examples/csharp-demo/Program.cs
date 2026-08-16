// Axiom C#/.NET runtime-layer spike target.
//
// Several worker tasks each call ProcessPayment (a synchronous method) so the
// netcoredbg-based tracer can be exercised for call attribution + argument
// reading. Kept synchronous on purpose - async methods lift arguments into
// compiler-generated state-machine fields (documented Phase 9 limitation).
using System;
using System.Threading;
using System.Threading.Tasks;

namespace AxiomDemo
{
    public static class Program
    {
        static readonly string[] Currencies = { "USD", "EUR", "GBP" };

        public static void Main()
        {
            Console.WriteLine("csharp-demo: starting payment workers");
            var rnd = new Random();
            var tasks = new Task[4];
            for (int w = 0; w < 4; w++)
            {
                int worker = w;
                tasks[w] = Task.Run(() =>
                {
                    var r = new Random(worker * 7 + 1);
                    for (int i = 0; i < 5; i++)
                    {
                        double amount = r.NextDouble() * 500 + 5;
                        if (r.NextDouble() < 0.2) amount = -amount;
                        string currency = Currencies[r.Next(Currencies.Length)];
                        string result = ProcessPayment(worker, amount, currency);
                        Console.WriteLine($"worker {worker}: {result}");
                        Thread.Sleep(300);
                    }
                });
            }
            Task.WaitAll(tasks);
            Console.WriteLine("csharp-demo: done");
        }

        // ProcessPayment is the watched method. Each concurrent worker calls it,
        // so hits attribute to different managed threads.
        public static string ProcessPayment(int worker, double amount, string currency)
        {
            if (amount < 0)
            {
                return $"REJECTED amount={amount:F2} {currency}";
            }
            return $"OK amount={amount:F2} {currency} tx={Guid.NewGuid().ToString("N").Substring(0, 8)}";
        }
    }
}
