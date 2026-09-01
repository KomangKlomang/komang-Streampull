import sys
import struct
import json
import subprocess
import os
import re
import tempfile


def read_message():
    try:
        raw_length = sys.stdin.buffer.read(4)
        if not raw_length:
            return None
        message_length = struct.unpack('@I', raw_length)[0]
        message_char = sys.stdin.buffer.read(message_length).decode('utf-8')
        return json.loads(message_char)
    except Exception as e:
        print(f"Error reading message: {e}", file=sys.stderr)
        return None


def send_message(message):
    try:
        encoded = json.dumps(message).encode('utf-8')
        sys.stdout.buffer.write(struct.pack('@I', len(encoded)))
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()
    except Exception as e:
        print(f"Error sending message: {e}", file=sys.stderr)


def main():
    while True:
        msg = read_message()
        if msg is None:
            break

        action = msg.get('action')

        if action == 'ping':
            send_message({"success": True, "message": "pong"})

        elif action == 'download':
            url = msg.get('url')
            if not url:
                send_message({"success": False, "error": "No URL provided"})
                continue

            filename = msg.get('filename')
            output_dir = msg.get('output_dir')
            format_val = msg.get('format', 'best')

            if filename:
                filename = re.sub(r'[<>:"/\\|?*&^%!]', '_', filename)

            if not output_dir:
                output_dir = os.path.join(os.path.expanduser('~'), 'Downloads')
            else:
                output_dir = os.path.expandvars(output_dir)

            os.makedirs(output_dir, exist_ok=True)

            if filename:
                output_template = os.path.join(output_dir, f"{filename}.%(ext)s")
            else:
                output_template = os.path.join(output_dir, "%(title)s.%(ext)s")

            script_dir = os.path.dirname(os.path.abspath(__file__))
            config_path = os.path.join(script_dir, 'config.json')
            ytdlp_path = 'yt-dlp'

            if os.path.exists(config_path):
                try:
                    with open(config_path, 'r', encoding='utf-8') as cf:
                        config = json.load(cf)
                        path_override = config.get('yt_dlp_path')
                        if path_override:
                            ytdlp_path = path_override
                except Exception as e:
                    print(f"Error reading config.json: {e}", file=sys.stderr)

            if ytdlp_path == 'yt-dlp':
                local_ytdlp = os.path.join(script_dir, 'yt-dlp.exe')
                if os.path.exists(local_ytdlp):
                    ytdlp_path = local_ytdlp

            try:
                download_args = []
                download_args.append('--live-from-start')
                download_args.append('--extractor-args "generic:impersonate"')
                download_args.append('--impersonate chrome')

                headers = msg.get('headers', {})
                referer = headers.get('referer')
                user_agent = headers.get('userAgent')
                cookie = headers.get('cookie')
                origin = headers.get('origin')

                if referer:
                    referer_esc = referer.replace('%', '%%')
                    download_args.append(f'--referer "{referer_esc}"')
                if user_agent:
                    user_agent_esc = user_agent.replace('%', '%%')
                    download_args.append(f'--user-agent "{user_agent_esc}"')
                if cookie:
                    cookie_esc = cookie.replace('%', '%%').replace('"', '""')
                    download_args.append(f'--add-header "Cookie:{cookie_esc}"')
                if origin:
                    origin_esc = origin.replace('%', '%%')
                    download_args.append(f'--add-header "Origin:{origin_esc}"')

                if format_val and format_val != 'best':
                    download_args.append(f'-f {format_val}')

                output_template_esc = output_template.replace('%', '%%')
                url_esc = url.replace('%', '%%')

                download_args.append(f'-o "{output_template_esc}"')
                download_args.append(f'"{url_esc}"')

                download_cmd_str = ' '.join(download_args)

                fd, temp_bat_path = tempfile.mkstemp(suffix='.bat', prefix='ksp_ytdlp_')
                with os.fdopen(fd, 'w', encoding='utf-8') as f:
                    f.write('@echo off\n')
                    f.write('chcp 65001 >nul\n')
                    f.write('echo ====================================================\n')
                    f.write('echo             KSP yt-dlp Live Recorder\n')
                    f.write('echo ====================================================\n')
                    f.write('echo Checking for updates...\n')
                    f.write(f'"{ytdlp_path}" -U\n')
                    f.write('echo.\n')
                    f.write('echo Starting download...\n')
                    f.write(f'"{ytdlp_path}" {download_cmd_str}\n')
                    f.write('(goto) 2>nul & del "%~f0"\n')

                cmd_str = f'cmd.exe /c start "KSP yt-dlp" cmd.exe /k "{temp_bat_path}"'
                subprocess.Popen(cmd_str, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)

                send_message({"success": True})
            except Exception as e:
                send_message({"success": False, "error": f"Failed to launch yt-dlp: {str(e)}"})


if __name__ == '__main__':
    main()
