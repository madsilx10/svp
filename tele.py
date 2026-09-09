import asyncio
import sys
from pyrogram import Client

# ─── CONFIG ──────────────────────────────────────────────────────────────────
API_ID   = 12345678      # ganti dengan api_id lo
API_HASH = "xxxxxxxx"    # ganti dengan api_hash lo

# ─── MAIN ────────────────────────────────────────────────────────────────────
async def main(session_string):
    async with Client(
        "svp_tele",
        api_id=API_ID,
        api_hash=API_HASH,
        session_string=session_string,
        no_updates=True,
    ) as app:

        # 1. Start bot @svpchain_bot
        print("[TG] Start bot @svpchain_bot...")
        try:
            await app.send_message("svpchain_bot", "/start")
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
        print("Usage: python3 tele.py <session_string>")
        sys.exit(1)
    asyncio.run(main(sys.argv[1]))
