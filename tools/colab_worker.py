#!/usr/bin/env python3
"""
Persistent ColabRuntime worker that keeps a single WebSocket connection open
to the active Google Colab session for low-latency real-time Jev-Omni inference.
"""
import base64
import json
import sys
from colab_cli.common import state
from colab_cli.runtime import ColabRuntime


def main():
    session_name = sys.argv[1] if len(sys.argv) > 1 else None
    name = state.resolve_session(session_name)
    s = state.store.get(name)
    if not s:
        print(json.dumps({"error": f"Session {name} not found"}), flush=True)
        sys.exit(1)

    runtime = ColabRuntime(
        s.url,
        s.token,
        kernel_id=s.kernel_id,
        session_id=s.session_id,
        on_kernel_started=lambda kid: (setattr(s, "kernel_id", kid), state.store.add(s)),
        on_session_started=lambda sid: (setattr(s, "session_id", sid), state.store.add(s)),
    )
    runtime.execute_code("import os; os.makedirs('/content', exist_ok=True); os.chdir('/content')")
    print("WORKER_READY", flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            py_snippet = (
                "import base64, json, time\n"
                f"_req = json.loads(base64.b64decode('{line}').decode('utf-8'))\n"
                "_t0 = time.time()\n"
                "_kw = {'state': _req['state'], 'question': _req['question'], 'options': _req['options']}\n"
                "if _req.get('modality') == 'image' and _req.get('image_b64'):\n"
                "    _raw = _req['image_b64'].split(',')[-1]\n"
                "    open('/content/aurora_frame.jpg', 'wb').write(base64.b64decode(_raw))\n"
                "    _kw['media'] = '/content/aurora_frame.jpg'\n"
                "    _kw['modality'] = 'image'\n"
                "_res = classifier.predict(**_kw)\n"
                "_res['latency_ms'] = round((time.time() - _t0) * 1000, 1)\n"
                "_res['backend'] = 'Colab A100 (Jev-Omni 12B)'\n"
                "print('JEV_JSON_START:' + json.dumps(_res))\n"
            )
            outputs = runtime.execute_code(py_snippet, timeout=15.0)
            found = None
            for out in outputs:
                txt = out.get("text", "") if isinstance(out, dict) else str(out)
                for ln in txt.splitlines():
                    if "JEV_JSON_START:" in ln:
                        found = ln.split("JEV_JSON_START:", 1)[1].strip()
            print(found if found else json.dumps({"error": "no output"}), flush=True)
        except Exception as e:
            print(json.dumps({"error": str(e)}), flush=True)


if __name__ == "__main__":
    main()
