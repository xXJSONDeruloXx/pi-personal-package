#!/bin/bash
# Test Poe models to find which ones are free (0 point cost)
# Requires POE_API_KEY to be set

API_KEY="${POE_API_KEY:-$1}"
if [ -z "$API_KEY" ]; then
    echo "Error: POE_API_KEY not set. Pass as argument or set env var."
    exit 1
fi

OUTPUT_DIR="${2:-/Users/danhimebauch/Developer/poe-free-models}"
mkdir -p "$OUTPUT_DIR"

RESULTS_FILE="$OUTPUT_DIR/free-models.md"
LOG_FILE="$OUTPUT_DIR/test-log.md"

# Get list of all models
echo "Fetching Poe model list..."
MODELS_JSON=$(curl -s "https://api.poe.com/v1/models" \
    -H "Authorization: Bearer $API_KEY")

if [ -z "$MODELS_JSON" ] || [ "$MODELS_JSON" = "null" ]; then
    echo "Error: Failed to fetch models or API returned null"
    exit 1
fi

# Extract model IDs
MODEL_IDS=$(echo "$MODELS_JSON" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    models = data.get('data', [])
    for m in models:
        print(m.get('id', ''))
except:
    pass
")

TOTAL=$(echo "$MODEL_IDS" | wc -l | tr -d ' ')
echo "Found $TOTAL models to test"

# Initialize results file
cat > "$RESULTS_FILE" << 'EOF'
# Poe Free Models Report

Models that cost 0 points per request.

Last tested: $(date -u +"%Y-%m-%d %H:%M:%S UTC")

## Free Models (0 point cost)

| Model ID | Name | Provider | Notes |
|----------|------|----------|-------|
EOF

# Initialize log
cat > "$LOG_FILE" << EOF
# Poe Model Testing Log

Started: $(date -u +"%Y-%m-%d %H:%M:%S UTC")

## Test Results

EOF

# Test each model with a simple "hi" message
test_model() {
    local model_id="$1"
    local test_num="$2"
    
    echo "[$test_num/$TOTAL] Testing: $model_id"
    
    # Try sending a message
    response=$(curl -s -X POST "https://api.poe.com/v1/chat/completions" \
        -H "Authorization: Bearer $API_KEY" \
        -H "Content-Type: application/json" \
        -d "{
            \"model\": \"$model_id\",
            \"messages\": [{\"role\": \"user\", \"content\": \"hi\"}],
            \"max_tokens\": 10
        }" 2>&1)
    
    # Check for errors that indicate cost/payment issues
    if echo "$response" | grep -q "insufficient_quota\|payment_required\|billing\|cost\|points"; then
        echo "  ❌ PAID (billing/cost error)"
        echo "- \`$model_id\`: Paid model" >> "$LOG_FILE"
        return 1
    fi
    
    # Check if we got a valid response
    if echo "$response" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    if 'choices' in data or 'content' in data or 'message' in data:
        sys.exit(0)
    else:
        sys.exit(1)
except:
    sys.exit(1)
" 2>/dev/null; then
        echo "  ✅ FREE (response received)"
        echo "- \`$model_id\`: FREE - got valid response" >> "$LOG_FILE"
        echo "| \`$model_id\` | | | Tested OK |" >> "$RESULTS_FILE"
        return 0
    fi
    
    # Check for rate limit (might be free but limited)
    if echo "$response" | grep -q "rate_limit\|too_many_requests\|Rate limit"; then
        echo "  ⚠️  RATE LIMITED (possibly free)"
        echo "- \`$model_id\`: RATE LIMITED - possibly free" >> "$LOG_FILE"
        return 2
    fi
    
    # Check pricing in the models list response
    pricing=$(echo "$MODELS_JSON" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    models = data.get('data', [])
    for m in models:
        if m.get('id') == '$model_id':
            pricing = m.get('pricing')
            if pricing is None:
                print('null')
            elif isinstance(pricing, dict):
                if pricing.get('input') == 0 and pricing.get('output') == 0:
                    print('zero')
                else:
                    print('paid')
            else:
                print('unknown')
            break
except:
    pass
")
    
    if [ "$pricing" = "null" ] || [ "$pricing" = "zero" ]; then
        echo "  ✅ FREE (pricing shows null/zero)"
        echo "- \`$model_id\`: FREE - pricing null/zero" >> "$LOG_FILE"
        echo "| \`$model_id\` | | | Pricing null/zero |" >> "$RESULTS_FILE"
        return 0
    fi
    
    echo "  ❓ UNKNOWN - check log"
    echo "- \`$model_id\`: UNKNOWN" >> "$LOG_FILE"
    echo "  Response snippet: $(echo "$response" | head -c 200)" >> "$LOG_FILE"
    return 3
}

# Counter
count=0
free_count=0

# Test each model
for model_id in $MODEL_IDS; do
    count=$((count + 1))
    test_model "$model_id" "$count"
    result=$?
    if [ $result -eq 0 ]; then
        free_count=$((free_count + 1))
    fi
    
    # Small delay to avoid rate limiting
    sleep 0.5
done

# Finalize results
cat >> "$RESULTS_FILE" << EOF

---

## Summary

- Total models tested: $TOTAL
- Free models found: $free_count
- Test completed: $(date -u +"%Y-%m-%d %H:%M:%S UTC")

## Files

- Full results: $RESULTS_FILE
- Detailed log: $LOG_FILE
EOF

echo ""
echo "========================================"
echo "Testing complete!"
echo "Total models: $TOTAL"
echo "Free models: $free_count"
echo "Results: $RESULTS_FILE"
echo "Log: $LOG_FILE"
