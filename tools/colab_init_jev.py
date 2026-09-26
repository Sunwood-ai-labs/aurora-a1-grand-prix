import os
import sys
import time

os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
import torch
from huggingface_hub import snapshot_download

t0 = time.time()
model_path = snapshot_download(repo_id="akhilaaa3/Jev-Omni", token=False)
if model_path not in sys.path:
    sys.path.insert(0, model_path)

from jev_omni import load_jev_omni
classifier = load_jev_omni()

allocated = torch.cuda.memory_allocated() / 1e9
print(f"[✓] Jev-Omni READY on A100 ({time.time() - t0:.1f}s) | VRAM: {allocated:.2f} GB", flush=True)
