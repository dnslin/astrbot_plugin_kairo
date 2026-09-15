"""使用指定 AstrBot 源码运行集成检查，不替换框架 API。"""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT.parent))
if source := os.environ.get("ASTRBOT_SOURCE"):
    sys.path.insert(0, str(Path(source).resolve()))
