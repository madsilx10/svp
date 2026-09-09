import asyncio
import sys
from pyrogram import Client

# ─── CONFIG ──────────────────────────────────────────────────────────────────
API_ID   = 12345678      # ganti dengan api_id lo
API_HASH = "xxxxxxxx"    # ganti dengan api_hash lo

async def main(session_string, start_param=None):
    async with Client(
        "svp_tele",
        api_id=API_ID,
        api_hash=API_HASH,
        session_string=session_string,
        no_updates=True,
    ) as app:

        # 1. Start bot dengan parameter dari tgLink
        print(f"[TG] Start bot @svpchain_bot (param: {start_param})...")
        try:
            msg = f"/start {start_param}" if start_param else "/start"
            await app.send_message("svpchain_bot", msg)
            print("[TG] ✅ Bot started")
        except Exception as e:
            print(f"[TG] ⚠️ Start bot: {e}")

        await asyncio.sleep(2)

        # 2. Join group
        print("[TG] Join @svp_group...")
        try:
            await app.join_chat("svp_group")
            print("[TG] ✅ Joined")
        except Exception as e:
            print(f"[TG] ⚠️ Join: {e}")

        await asyncio.sleep(3)

        # 3. Klik "Click prove you're human" dari bot di group
        print("[TG] Cari button di group...")
        try:
            found = False
            async for msg in app.get_chat_history("svp_group", limit=30):
                if not msg.reply_markup:
                    continue
                for row in msg.reply_markup.inline_keyboard:
                    for btn in row:
                        if btn.text and "prove" in btn.text.lower():
                            print(f"[TG] Klik: {btn.text}")
                            await msg.click(btn.text)
                            print("[TG] ✅ Diklik!")
                            found = True
                            break
                    if found:
                        break
                if found:
                    break
            if not found:
                print("[TG] ⚠️ Button tidak ditemukan")
        except Exception as e:
            print(f"[TG] ⚠️ Klik: {e}")

        print("[TG] Done")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 tele.py <session_string> [start_param]")
        sys.exit(1)
    session = sys.argv[1]
    param   = sys.argv[2] if len(sys.argv) > 2 else None
    asyncio.run(main(session, param))
