"""使用指定 AstrBot 源码运行集成检查，不替换框架 API。"""

import atexit
import os
import shutil
import sys
import tempfile
from pathlib import Path

# Metrics spawn unrelated DB/network tasks; these tests exercise platform behavior.
os.environ["ASTRBOT_DISABLE_METRICS"] = "1"

# Framework imports normalize configuration; never use the developer's live data.
if "ASTRBOT_ROOT" not in os.environ:
    temporary_root = tempfile.mkdtemp(prefix="kairo-tests-")
    os.environ["ASTRBOT_ROOT"] = temporary_root
    atexit.register(shutil.rmtree, temporary_root, ignore_errors=True)

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT.parent))
if source := os.environ.get("ASTRBOT_SOURCE"):
    sys.path.insert(0, str(Path(source).resolve()))
