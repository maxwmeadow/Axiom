# Axiom Ruby runtime-layer spike target.
#
# Several threads each call process_payment so the rdbg-DAP tracer can be
# exercised for call attribution + argument reading. Run:  ruby app.rb
CURRENCIES = %w[USD EUR GBP].freeze

# process_payment is the watched method. Each worker thread calls it, so hits
# attribute to different threads.
def process_payment(worker, amount, currency)
  if amount < 0
    return format('REJECTED amount=%.2f %s', amount, currency)
  end
  format('OK amount=%.2f %s tx=%d', amount, currency, rand(100000))
end

def main
  puts 'ruby-demo: starting payment workers'
  threads = (0...4).map do |w|
    Thread.new do
      rng = Random.new(w * 7 + 1)
      5.times do
        amount = rng.rand * 500 + 5
        amount = -amount if rng.rand < 0.2
        currency = CURRENCIES[rng.rand(CURRENCIES.length)]
        result = process_payment(w, amount, currency)
        puts "worker #{w}: #{result}"
        sleep 0.3
      end
    end
  end
  threads.each(&:join)
  puts 'ruby-demo: done'
end

main
