<div align="center">

# AURORA A1 Grand Prix

### FreeCAD で設計した F1 マシンを、そのままブラウザで走らせるレースゲーム

<img src="docs/images/gameplay.gif" width="640" alt="gameplay">

[![Play](https://img.shields.io/badge/%E2%96%B6%20PLAY-now-ff2aa6?style=for-the-badge)](https://sunwood-ai-labs.github.io/aurora-a1-grand-prix/)

[![three.js](https://img.shields.io/badge/three.js-r170-000?logo=threedotjs)](https://threejs.org/)
[![FreeCAD model](https://img.shields.io/badge/model-FreeCAD%201.1-418FDE?logo=freecad&logoColor=white)](https://github.com/Sunwood-ai-labs/aurora-a1-freecad)
[![No build](https://img.shields.io/badge/build-none%20(static%20HTML)-6a3cff)](#-ローカルで遊ぶ)

**▶ https://sunwood-ai-labs.github.io/aurora-a1-grand-prix/**

</div>

---

## 🏎️ どんなゲーム？

AIエージェントが FreeCAD で設計した F1 コンセプトカー **AURORA A1**（[CAD リポジトリ](https://github.com/Sunwood-ai-labs/aurora-a1-freecad)）に乗って、3台のライバルと 2.9 km のサーキットでレースします。
車の形状、パーツの色、ロゴ（AURORA / 77）は、すべて CAD のビルドスクリプトから書き出したものです。

<table>
<tr>
<td width="50%"><img src="docs/images/start_lights.png" alt="start lights"><br><sub><b>5 灯のスタートシグナル</b>：全灯のあと、ランダムな間を置いて消灯したらスタート</sub></td>
<td width="50%"><img src="docs/images/battle.png" alt="battle"><br><sub><b>ライバルとバトル</b>：AI は走行ラインを取り、前の車を避けて抜きにくる</sub></td>
</tr>
<tr>
<td><img src="docs/images/cockpit.png" alt="cockpit"><br><sub><b>コックピット視点</b>：CAD で作った Halo とステアリング越しの景色</sub></td>
<td><img src="docs/images/tv_cam.png" alt="tv camera"><br><sub><b>中継カメラ</b>：コース脇から望遠で追いかける</sub></td>
</tr>
<tr>
<td><img src="docs/images/title.png" alt="title"><br><sub><b>タイトル画面</b>：周回数（1 / 3 / 5）とライバルの強さ（3段階）を選択</sub></td>
<td><img src="docs/images/result.png" alt="result"><br><sub><b>リザルト</b>：順位・ベストラップ。自己ベストはブラウザに保存</sub></td>
</tr>
</table>

### 特徴

- **FreeCAD の CAD モデルそのまま**：約24万ポリゴン。前輪はステアリングに合わせて切れ、車体は加減速とコーナリングで沈み込みます。
- **F1 らしい走り**：ダウンフォース（速度の2乗で増える横グリップ）、速度に応じたステアリング、アンダーステア、芝生での減速、バリアとの衝突。
- **AI ライバル 3台**：コースの曲率から計算した速度プロファイルで走り、前の車がいればラインを変えて抜きにきます。
- **HUD**：速度・ギア（8速）・回転数、順位表とタイム差、ミニマップ、ラップタイム。
- **4つのカメラ**：後方追従 / 遠め / コックピット / 中継カメラ。
- **サウンドは全部合成**：エンジン音、タイヤのスキール音、衝突音、スタート音を WebAudio で生成（音声ファイルなし）。
- **スマホ対応**：タッチ端末では画面上に操作ボタンが出ます。

## 🎮 操作

| キー | 動作 |
| --- | --- |
| <kbd>↑</kbd> / <kbd>W</kbd> | アクセル |
| <kbd>↓</kbd> / <kbd>S</kbd> | ブレーキ（止まった状態で押し続けるとバック） |
| <kbd>←</kbd> <kbd>→</kbd> / <kbd>A</kbd> <kbd>D</kbd> | ハンドル |
| <kbd>J</kbd> | **Jev-Omni AI パイロット切替**（`MANUAL` → `TEXT 12B` → `VISION 12B`） |
| <kbd>C</kbd> | カメラ切り替え |
| <kbd>R</kbd> | コースに戻る |
| <kbd>M</kbd> | サウンド オン / オフ |
| <kbd>Esc</kbd> / <kbd>P</kbd> | ポーズ |

---

## 🧠 Jev-Omni (Gemma 4 12B System-1) AI パイロットモード

オープンウェイトのマルチモーダル意思決定分類器 **[`akhilaaa3/Jev-Omni`](https://huggingface.co/akhilaaa3/Jev-Omni)**（Gemma 4 12B-IT ベース）と連携し、トークン生成を行わずに 1 回の Forward Pass で 6 つのドライビングアクション（`FULL_GAS_STRAIGHT` / `GAS_STEER_LEFT` / `GAS_STEER_RIGHT` / `BRAKE_ENTRY_LEFT` / `BRAKE_ENTRY_RIGHT` / `HARD_BRAKE`）の確率分布をリアルタイム推論して走行します。

<div align="center">
<img src="docs/images/jev_gameplay.gif" width="640" alt="Jev-Omni Gameplay">
</div>

<table>
<tr>
<td width="50%"><img src="docs/images/jev_cockpit_vision.png" alt="Jev-Omni Cockpit Vision"><br><sub><b>JEV-VISION（マルチモーダル推論）</b>：WebGL キャンバス画像＋テレメトリを Colab A100 上の Jev-Omni に入力（約 138 ms）</sub></td>
<td width="50%"><img src="docs/images/jev_battle_lead.png" alt="Jev-Omni Battle"><br><sub><b>JEV-TEXT（テレメトリ高速推論）</b>：ヘアピン進入で先頭 NOVA のインを突きオーバーテイク（約 98 ms）</sub></td>
</tr>
<tr>
<td><img src="docs/images/jev_far_cam.png" alt="Jev-Omni Lead"><br><sub><b>P1 独走体制</b>：6 選択肢のリアルタイム確率バーとレイテンシを左 HUD に表示</sub></td>
<td><img src="docs/images/jev_result.png" alt="Jev-Omni Victory"><br><sub><b>VICTORY!</b>：P4 グリッドから全車オーバーテイクし 1:00.913 で優勝</sub></td>
</tr>
</table>

### Google Colab ノートブック / ブリッジサーバーでの起動

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/Sunwood-ai-labs/aurora-a1-grand-prix/blob/main/notebooks/Jev_Omni_A100_Colab.ipynb)

- **Colab ノートブック上で直接動かす場合**: [`notebooks/Jev_Omni_A100_Colab.ipynb`](notebooks/Jev_Omni_A100_Colab.ipynb) を開くと、本リポジトリを自動クローンし、Colab A100 GPU 上に `akhilaaa3/Jev-Omni` をロードしてインプロセス（約 98〜138 ms）の完全リアルタイム推論（時間を止めない 60FPS 動作）でレースを実行できます。
- **ローカル PC から Google Colab CLI (`colab`) 経由で A100 に常時接続する場合**:

```bash
# 1. Google Colab CLI (WSL2) で A100 セッションを作成し Jev-Omni を GPU にロード
wsl bash -c '~/.local/bin/colab new --gpu A100 -s jev-racer'
wsl bash -c '~/.local/bin/colab exec -s jev-racer --timeout 180 -f /mnt/c/Prj/Aurora_A1_Racer/tools/colab_init_jev.py'

# 2. 永続 WebSocket ブリッジサーバーを起動（Colab セッション未指定時はローカル System-1 に自動フォールバック）
python tools/jev_bridge.py --port 8765 --colab-session jev-racer
```

---

## 🔧 CAD モデルがゲームになるまで

```mermaid
flowchart LR
    A["build_aurora_a1.py<br/>（FreeCAD の組立スクリプト）"] -->|freecadcmd| B["tools/export_glb.py"]
    B -->|"パーツごとにメッシュ化<br/>色ごとに統合<br/>座標系を変換"| C["assets/aurora_a1.glb<br/>約24万ポリゴン・6MB"]
    C -->|GLTFLoader| D["three.js<br/>js/main.js"]
```

<table>
<tr>
<td width="50%"><img src="docs/images/cad_hero.png" alt="FreeCAD render"><br><sub>FreeCAD でのレンダー</sub></td>
<td width="50%"><img src="docs/images/far_cam.png" alt="in game"><br><sub>ゲーム内（three.js）</sub></td>
</tr>
</table>

[`tools/export_glb.py`](tools/export_glb.py) の処理は次のとおりです。

1. CAD のビルドスクリプト（`build_chassis()`・`build_aero()` など）を FreeCAD のヘッドレス環境で直接呼び、各パーツの形状と色を取得します。
2. 面ごとにメッシュ化します（線形 2 mm・角度 0.35 rad）。全パーツを細かく割ると 180万ポリゴン・50MB になったので、ゲーム用に粗くしています。
3. 同じ色のパーツを1つのメッシュにまとめ、FreeCAD の色を PBR マテリアル（sRGB → リニア変換、カーボンやタイヤは粗め）にします。
4. 4本のホイールは別ノード（`Hub_XX` → `Wheel_XX` + `Caliper_XX`）にします。ゲーム側でホイールを回転させ、前輪は操舵させつつ、キャリパーは回さないためです。
5. 座標系を変換します：FreeCAD（X＝後方・Z＝上・mm）→ three.js（+Z＝前方・Y＝上・m）。

CAD を修正したら、次のコマンドで車を更新できます。

```
freecadcmd tools/export_glb.py
```

> 読み込み元は `C:\Prj\FreeCAD_Demo_001\aurora_a1` に固定しています。別の場所で使う場合は、スクリプト冒頭の `SRC` を書き換えてください。

---

## 💻 ローカルで遊ぶ

[`start_game.bat`](start_game.bat) をダブルクリックするか、以下を実行すると Jev-Omni ブリッジ付きの HTTP サーバーが起動します。

```bash
python tools/jev_bridge.py --port 8765
```

→ <http://localhost:8765/> を開きます。

## 📁 構成

```
index.html / style.css       HUD（Jev-Omni テレメトリパネル含む）とメニュー
js/main.js                   ゲームループ、車の物理、Jev-Omni AI パイロット、カメラ、HUD
js/track.js                  コース生成（スプライン）：路面・縁石・バリア・スタートゲート・景色
js/audio.js                  エンジン音などの合成（WebAudio）
assets/aurora_a1.glb         FreeCAD から書き出した車のモデル
tools/jev_bridge.py          Jev-Omni ローカル HTTP ブリッジ（Google Colab CLI A100 対応）
tools/colab_init_jev.py      Colab A100 セッション上に Jev-Omni をロードする初期化スクリプト
tools/run_jev_race.py        ヘッドレス Chrome + Colab A100 による自動レース＆テレメトリ記録
tools/export_glb.py          FreeCAD → GLB エクスポーター
docs/images/                 スクリーンショット・Jev-Omni 走行 GIF
docs/jev_omni_race_log.json  Colab A100 Jev-Omni の実推論ログ
```

## 🧪 デバッグ

ブラウザのコンソールから `__aurora` を操作できます。README のスクリーンショットもこれを使い、ヘッドレス Chrome で撮影しました。

```js
__aurora.jev('vision')   // Jev-Omni AI パイロット切り替え ('off' | 'text' | 'vision')
__aurora.telemetry()     // Jev-Omni 入力用テレメトリとプロンプトを取得
__aurora.run(10)         // シミュレーションを 10 秒進める
__aurora.cam(2)          // カメラ切り替え（0: 追従, 1: 遠め, 2: コックピット, 3: 中継）
__aurora.info()          // 速度・順位・ラップ・Jev-Omni 推論結果など
```

## 🔗 関連

- **CAD モデル**：[Sunwood-ai-labs/aurora-a1-freecad](https://github.com/Sunwood-ai-labs/aurora-a1-freecad)（3Dモデル・図面11枚・メイキング動画）
- **Jev-Omni モデル**：[akhilaaa3/Jev-Omni](https://huggingface.co/akhilaaa3/Jev-Omni)

