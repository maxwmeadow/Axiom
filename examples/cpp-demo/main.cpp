// Axiom C++ runtime-layer spike target.
//
// Several worker threads each call process_payment so the gdb-DAP tracer can be
// exercised for call attribution + argument reading. Build with debug info:
//   g++ -g -O0 -o cpp-demo main.cpp
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>
#include <vector>
#include <chrono>

// process_payment is the watched function. Each worker thread calls it, so hits
// attribute to different OS threads.
std::string process_payment(int worker, double amount, const std::string& currency) {
    char buf[128];
    if (amount < 0) {
        std::snprintf(buf, sizeof(buf), "REJECTED amount=%.2f %s", amount, currency.c_str());
        return std::string(buf);
    }
    std::snprintf(buf, sizeof(buf), "OK amount=%.2f %s tx=%d", amount, currency.c_str(), std::rand() % 100000);
    return std::string(buf);
}

int main() {
    std::printf("cpp-demo: starting payment workers\n");
    const char* currencies[] = {"USD", "EUR", "GBP"};
    std::vector<std::thread> workers;
    for (int w = 0; w < 4; ++w) {
        workers.emplace_back([w, &currencies]() {
            std::srand(w * 7 + 1);
            for (int i = 0; i < 5; ++i) {
                double amount = (std::rand() % 50000) / 100.0 + 5;
                if ((std::rand() % 100) < 20) amount = -amount;
                std::string currency = currencies[std::rand() % 3];
                std::string result = process_payment(w, amount, currency);
                std::printf("worker %d: %s\n", w, result.c_str());
                std::this_thread::sleep_for(std::chrono::milliseconds(300));
            }
        });
    }
    for (auto& t : workers) t.join();
    std::printf("cpp-demo: done\n");
    return 0;
}
