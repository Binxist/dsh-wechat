# -*- coding: utf-8 -*-
"""A 阶段通路验证：只往「文件传输助手」发一条消息，然后回读数据库确认。

为什么只发 filehelper：
  filehelper 是「自己→自己」的会话，不打扰任何人，也不进入任何群。
  验证目标是「读数据库 + UIA 发送」这两条链路是否通，跟收件人是谁无关。

用法（必须用包内 Python）：
  runtime\\python\\python.exe scripts\\test-send-self.py
  runtime\\python\\python.exe scripts\\test-send-self.py --no-send   # 只读，不发送
"""
import os
import sys
import time
import datetime

os.environ.setdefault("WECHATAUTO_RHYTHM", "off")
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

FILEHELPER = "filehelper"


def step(msg):
    print(f"[{datetime.datetime.now():%H:%M:%S}] {msg}", flush=True)


def main():
    no_send = "--no-send" in sys.argv

    step("import wechatauto …")
    from wechatauto import WeChatDB, __version__

    step(f"wechatauto {__version__} 已导入")

    step("连接本地数据库（需要微信已登录）…")
    db = WeChatDB()
    info = db.get_self_info()
    step(f"账号 = {info.get('nick_name') or '(无昵称)'} / {info.get('username', '?')}")
    step(f"账号目录 = {getattr(db, 'account', '(未知)')}")

    before = db.get_messages(FILEHELPER, limit=1)
    before_id = before[0].get("local_id") if before else 0
    step(f"发送前最后一条 local_id = {before_id}")

    if no_send:
        step("--no-send：只读模式，到此为止")
        return 0

    text = f"[bridge-test] {datetime.datetime.now():%Y-%m-%d %H:%M:%S}"
    step(f"UIA 发送到「文件传输助手」：{text}")

    from wechatauto import quick_send
    resp = quick_send(text, "文件传输助手", verify=True)
    step(f"quick_send 返回 = {resp}")

    step("回读数据库确认（不信任返回值）…")
    ok = False
    for i in range(8):
        time.sleep(1.5)
        msgs = db.get_messages(FILEHELPER, limit=5)
        hit = [m for m in msgs if text in str(m.get("content", ""))]
        if hit:
            ok = True
            m = hit[0]
            step(f"✅ 数据库里找到了这条消息：local_id={m.get('local_id')} "
                 f"type={m.get('type')} time={m.get('create_time')}")
            break
        step(f"  第 {i + 1} 次没找到（共 {len(msgs)} 条）")

    if not ok:
        step("❌ 数据库里没有出现这条消息——UIA 发送没真正落到微信里")
        step("   下一步：runtime\\python\\python.exe tools\\uia-diag.py --all")
        return 1

    step("A 阶段通路验证通过：读库 + UIA 发送都可用")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"\n❌ 失败：{type(exc).__name__}: {exc}", flush=True)
        raise SystemExit(1)
