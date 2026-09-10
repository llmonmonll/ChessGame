# ChessGame（Grandmaster Chess）

ブラウザ上で **Stockfish（WebAssembly）** と対局できる本格チェスです。日本語 UI、棋譜・持ち時間・ CPU 強さの調整に対応しています。

## 必要環境

- **Git LFS**（クローン時）— `assets/engine/stockfish.wasm` が [Git LFS](https://git-lfs.github.com/) 管理のため、clone 前に `git lfs install` を推奨します。
- **Python 3**（ローカル実行時）— 付属の `serve.py` で静的配信します。

> `file://` で直接 `index.html` を開くと、エンジン用の **SharedArrayBuffer** が使えず動作しないことがあります。必ず下記のサーバー経由で開いてください。

## 起動方法

### Windows

リポジトリのルートで `start.bat` を実行します。ブラウザが `http://127.0.0.1:8765/index.html` を開き、Python がサーバーを起動します。

### 手動

```bash
python serve.py
```

ブラウザで **http://127.0.0.1:8765/index.html** を開きます。

`serve.py` は **COOP / COEP** ヘッダを付与し、WASM スレッド利用に必要な環境を整えます。開発時はキャッシュ無効化ヘッダも付きます。

## リポジトリ構成（概要）

| パス | 説明 |
|------|------|
| `index.html` | アプリのエントリ |
| `assets/styles.css` | スタイル |
| `assets/chess.js` | 盤・ルール周り |
| `assets/engine/` | Stockfish WASM・ブリッジスクリプト |
| `serve.py` | ローカル用 HTTP サーバー |
| `start.bat` | Windows 用ワンクリック起動 |

## ライセンス

リポジトリ内の [LICENSE](LICENSE)（MIT）に従います。エンジンバイナリ・サードパーティ成果物については、各ディレクトリのライセンス表記（例: `assets/engine/*Copying*`）もあわせて確認してください。

## リンク

- リポジトリ: [https://github.com/llmonmonll/ChessGame](https://github.com/llmonmonll/ChessGame)
