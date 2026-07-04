// Axiom Java runtime-layer spike target.
//
// Several worker threads each call processPayment (synchronous) so the
// java-debug DAP tracer can be exercised for call attribution + arg reading.
//   javac Payment.java && java Payment
import java.util.Random;

public class Payment {
    static final String[] CURRENCIES = {"USD", "EUR", "GBP"};

    // processPayment is the watched method. Each worker thread calls it, so
    // hits attribute to different threads.
    static String processPayment(int worker, double amount, String currency) {
        if (amount < 0) {
            return String.format("REJECTED amount=%.2f %s", amount, currency);
        }
        return String.format("OK amount=%.2f %s tx=%d", amount, currency, new Random().nextInt(100000));
    }

    public static void main(String[] args) throws InterruptedException {
        System.out.println("java-demo: starting payment workers");
        Thread[] workers = new Thread[4];
        for (int w = 0; w < 4; w++) {
            final int worker = w;
            workers[w] = new Thread(() -> {
                Random rng = new Random(worker * 7 + 1);
                for (int i = 0; i < 5; i++) {
                    double amount = rng.nextDouble() * 500 + 5;
                    if (rng.nextDouble() < 0.2) amount = -amount;
                    String currency = CURRENCIES[rng.nextInt(CURRENCIES.length)];
                    String result = processPayment(worker, amount, currency);
                    System.out.println("worker " + worker + ": " + result);
                    try { Thread.sleep(300); } catch (InterruptedException e) {}
                }
            });
            workers[w].start();
        }
        for (Thread t : workers) t.join();
        System.out.println("java-demo: done");
    }
}
