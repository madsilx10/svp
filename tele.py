import asyncio
import sys
from pyrogram import Client
from pyrogram.raw import functions, types

async def main(session_string, start_param=None):
    async with Client(
        "svp_tele",
        session_string=session_string,
        no_updates=True,
    ) as app:
        # 1. Start bot dengan param unik
        start_cmd = f"/start {start_param}" if start_param else "/start"
        print(f"[TG] Send '{start_cmd}' ke @svpchain_bot...")
        try:
            await app.send_message("svpchain_bot", start_cmd)
            print("[TG] ✅ Bot started")
        except Exception as e:
            print(f"[TG] ⚠️ Start bot: {e}")

        await asyncio.sleep(3)

        # 2. Join group
        print("[TG] Join group @svp_group...")
        try:
            await app.join_chat("svp_group")
            print("[TG] ✅ Joined group")
        except Exception as e:
            print(f"[TG] ⚠️ Join group: {e}")

        await asyncio.sleep(3)

        # 3. Klik tombol "prove you're human" dari bot di group
        print("[TG] Cari pesan bot di group...")
        try:
            found = False
            async for msg in app.get_chat_history("svp_group", limit=30):
                if msg.reply_markup and hasattr(msg.reply_markup, 'inline_keyboard'):
                    for row in msg.reply_markup.inline_keyboard:
                        for btn in row:
                            if btn.text and "prove" in btn.text.lower():
                                print(f"[TG] Ketemu button: {btn.text}")
                                await msg.click(btn.text)
                                print("[TG] ✅ Button diklik!")
                                found = True
                                break
                        if found:
                            break
                if found:
                    break

            if not found:
                print("[TG] ⚠️ Button tidak ditemukan di 30 pesan terakhir")
        except Exception as e:
            print(f"[TG] ⚠️ Klik button: {e}")

        await asyncio.sleep(1)
        print("[TG] Done")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 tele.py <session_string> [start_param]")
        sys.exit(1)
    session_string = sys.argv[1]
    start_param = sys.argv[2] if len(sys.argv) >= 3 else None
    print(f"[TG] start_param: {start_param}")
    asyncio.run(main(session_string, start_param))
