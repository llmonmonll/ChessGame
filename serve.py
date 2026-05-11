#!/usr/bin/env python3
"""YaneuraOu.wasm 用: SharedArrayBuffer を有効にする COOP/COEP 付き静的サーバー。
使い方: python serve.py  → ブラウザで http://127.0.0.1:8765/index.html を開く
"""
import http.server
import socketserver
import threading

PORT = 8765


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # 開発用: 古い chess.js がキャッシュされ「起動直後から対局」になるのを防ぐ
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def do_POST(self):
        if self.path != "/__shutdown__":
            self.send_error(404, "Not Found")
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write("shutting down".encode("utf-8"))

        # レスポンス返却後にサーバーを停止
        threading.Thread(target=self.server.shutdown, daemon=True).start()


if __name__ == "__main__":
    with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
        print(f"Serving http://127.0.0.1:{PORT}/  (COOP/COEP 有効)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")
