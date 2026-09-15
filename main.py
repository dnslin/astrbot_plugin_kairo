from astrbot.api.star import Context, Star


class KairoPlugin(Star):
    """加载平台适配器；连接由 AstrBot 的平台管理器维护。"""

    def __init__(self, context: Context) -> None:
        super().__init__(context)
        from .adapter import KairoPlatformAdapter  # noqa: F401
