#!/bin/bash

echo "=== Testing Rate Limiting for DNS Queries ==="
echo "Rate limit is set to 100 queries per 60 seconds per IP"
echo ""
echo "Testing from 127.0.0.1 (localhost)..."
echo ""

# Function to send queries and check results
test_rate_limit() {
    local count=0
    local failures=0
    local start_time=$(date +%s)

    # Send 110 queries rapidly (should exceed the 100 limit)
    echo "Sending 110 rapid DNS queries..."
    for i in {1..110}; do
        response=$(dig @localhost test$i.example.com A +short +tries=1 +time=1 2>&1)
        if echo "$response" | grep -q "REFUSED\|timed out\|no servers could be reached"; then
            ((failures++))
            if [ $failures -eq 1 ]; then
                echo "Query $i: RATE LIMITED (REFUSED) - Rate limit triggered!"
            fi
        else
            ((count++))
        fi

        # Print progress every 10 queries
        if [ $((i % 10)) -eq 0 ]; then
            echo "  Sent $i queries: $count succeeded, $failures rate limited"
        fi
    done

    local end_time=$(date +%s)
    local duration=$((end_time - start_time))

    echo ""
    echo "=== Test Results ==="
    echo "Total queries sent: 110"
    echo "Queries succeeded: $count"
    echo "Queries rate limited: $failures"
    echo "Time taken: ${duration}s"
    echo ""

    if [ $failures -gt 0 ]; then
        echo "✓ Rate limiting is WORKING! Queries were blocked after exceeding limit."
    else
        echo "⚠ Rate limiting may not be active or limit not reached."
    fi

    # Check logs for rate limiting messages
    echo ""
    echo "=== Checking logs for rate limiting activity ==="
    journalctl -u mydns --since "30 seconds ago" --no-pager | grep -i "rate" | tail -5
}

# Run the test
test_rate_limit

echo ""
echo "=== Waiting 60 seconds for rate limit window to reset ==="
sleep 60

echo ""
echo "=== Testing after rate limit window reset ==="
echo "Sending 5 queries (should all succeed)..."
for i in {1..5}; do
    response=$(dig @localhost reset$i.example.com A +short +tries=1 +time=1 2>&1)
    if echo "$response" | grep -q "REFUSED\|timed out"; then
        echo "Query $i: FAILED (unexpected)"
    else
        echo "Query $i: SUCCESS"
    fi
done

echo ""
echo "=== Rate Limiting Test Complete ==="