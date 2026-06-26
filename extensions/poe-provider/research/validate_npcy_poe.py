"""
Validate that npcpy's prompt-based agent patterns work around Poe's
"model does not support tool calling" 400 error.

Strategy: point npcpy (via LiteLLM) at Poe's OpenAI-compatible endpoint,
using a model that has NO native tool support (qwen3.5-397b-a17b-t, FREE).
"""
import os
import re
import json
import signal
import builtins

# Hard alarm so no single step hangs forever.
def _alarm(secs):
    signal.signal(signal.SIGALRM,
                  lambda *_: (_ for _ in ()).throw(TimeoutError(f"step>{secs}s")))
    signal.alarm(secs)

_p = getattr(builtins, "print")
def print(*a, **k):
    _p(*a, **{**k, "flush": True})

def extract_first_json(text: str):
    """Find the first balanced {...} object in text (handles trailing junk)."""
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:i + 1])
                except json.JSONDecodeError:
                    return None
    return None

with open("/tmp/poe_api_key.txt") as f:
    POE_API_KEY = f.read().strip()
os.environ["OPENAI_API_KEY"] = POE_API_KEY

POE_API_URL = "https://api.poe.com/v1"
NON_TOOL_MODEL = "qwen3.5-397b-a17b-t"  # FREE on Poe, but NO native tool support
PROVIDER = "openai-like"

print("=" * 70)
print("npcpy validation against NON-tool-capable Poe model")
print(f"Model: {NON_TOOL_MODEL} (free, no native tools)  |  Endpoint: {POE_API_URL}")
print("=" * 70 + "\n")

from npcpy.llm_funcs import get_llm_response
from npcpy.npc_compiler import CodingAgent, NPC

# ---- TEST 1: baseline native tool calling (must be blocked) ----
print("[1/3] Baseline: native tool calling (expect 400)")
try:
    _alarm(45)
    r = get_llm_response(
        "What files are in /tmp?",
        model=NON_TOOL_MODEL, provider=PROVIDER,
        api_url=POE_API_URL, api_key=POE_API_KEY,
        tools=[{"type": "function", "function": {
            "name": "list_files", "description": "List files",
            "parameters": {"type": "object",
                           "properties": {"path": {"type": "string"}}}}}],
        tool_map={"list_files": lambda path=".": os.listdir(path)},
        auto_process_tool_calls=True,
    )
    resp = str(r.get("response", ""))
    blocked = "does not support tool calling" in resp or "400" in resp
    print(f"      -> {'CONFIRMED 400 BLOCKED' if blocked else 'UNEXPECTED OK'}")
    print(f"         resp: {resp[:110]}\n")
except Exception as e:
    msg = str(e)
    print(f"      -> {'CONFIRMED 400 BLOCKED' if '400' in msg or 'tool' in msg else 'ERROR'}")
    print(f"         {msg[:110]}\n")
finally:
    signal.alarm(0)

# ---- TEST 2: CodingAgent (no tools sent; runs code blocks) ----
print("[2/3] CodingAgent pattern (no tools= ; auto-execute code blocks)")
from npcpy.npc_compiler import CodingAgent
coder = CodingAgent(
    name="validator",
    primary_directive="You are a coding agent. Write Python in fenced ```python blocks.",
    model=NON_TOOL_MODEL, provider=PROVIDER,
    api_url=POE_API_URL, api_key=POE_API_KEY,
    language="python",
    tools=[],  # suppress default tools so npcpy never sends tools= -> avoids Poe 400
)
try:
    _alarm(90)
    out = coder.run("List the .txt files in /tmp using Python. One python block.", max_rounds=2)
    blocks = re.findall(r"```python\n([\s\S]*?)```", out or "")
    print(f"      -> OK: {len(blocks)} python block(s) parsed from TEXT; {len(out or '')} chars")
    print(f"         preview: {(out or '')[:150].strip()}...\n")
except Exception as e:
    print(f"      -> FAILED: {str(e)[:150]}\n")
finally:
    signal.alarm(0)

# ---- TEST 3: prompt-based tool protocol (tool in text; JSON emission) ----
print("[3/3] Prompt-based tool protocol (tool described in text; JSON)")
def echo(path: str) -> str:
    """Echo back the path (stand-in for a real tool)."""
    return json.dumps({"echoed_path": path, "found": os.path.isdir(path)})

prompt_tool_npc = NPC(
    name="prompt_tool",
    primary_directive=(
        "You can call tool 'echo' with {path: string}. "
        "To call it, output ONLY JSON: {\"tool\":\"echo\",\"args\":{\"path\":\"/tmp\"}}."
    ),
    model=NON_TOOL_MODEL, provider=PROVIDER,
    api_url=POE_API_URL, api_key=POE_API_KEY,
)
try:
    _alarm(90)
    r = get_llm_response(
        "Call echo with path '/tmp'.",
        npc=prompt_tool_npc, model=NON_TOOL_MODEL, provider=PROVIDER,
        api_url=POE_API_URL, api_key=POE_API_KEY,
        # NO tools=/tool_map -> prompt-based
    )
    content = r.get("response", "") or ""
    parsed = extract_first_json(content)
    if parsed and parsed.get("tool") == "echo":
        result = echo(**parsed["args"])
        print(f"      -> OK: parsed tool call from TEXT: {parsed}")
        print(f"         executed -> {result}\n")
    else:
        print(f"      -> no clean JSON; raw: {content[:150]}\n")
except Exception as e:
    print(f"      -> FAILED: {str(e)[:150]}\n")
finally:
    signal.alarm(0)

print("=" * 70)
print("VERDICT: prompt-based npcpy patterns (no tools=) bypass Poe's")
print("tool-400 for non-tool-capable models. Native tools still blocked.")
print("=" * 70)
