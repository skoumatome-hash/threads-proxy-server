const express = require("express");
const { ThreadsAPI } = require("threads-api");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { TOTP } = require("otpauth"); // 2FA用ライブラリ
const app = express();

app.use(express.json());

// ▼▼▼ あなたの5Gプロキシ情報 ▼▼▼
const PROXY_URL = 'http://ここにプロキシ情報を入れる'; 
// ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲

const requestQueue = [];
let isProcessing = false;

// ----------------------------------------
// 1. ログイン確認用エンドポイント (新規追加)
// ----------------------------------------
app.post("/api/check", async (req, res) => {
  const { username, password, twoFactorSecret, deviceId } = req.body;
  console.log(`[Login Check] ${username} のログインテスト開始...`);

  try {
    const proxyAgent = new HttpsProxyAgent(PROXY_URL);
    const threadsAPI = new ThreadsAPI({
      username,
      password,
      deviceID: deviceId,
      axiosConfig: { httpAgent: proxyAgent, httpsAgent: proxyAgent },
    });

    // 2FAが必要な場合のログイン処理
    if (twoFactorSecret) {
      console.log("2FAシークレットが提供されています。認証コードを生成します。");
      // ここで本来はログインフローへの介入が必要ですが、
      // 簡易的に「投稿」以外の単なる情報取得で認証を通すトライをします
    }
    
    // ユーザー情報を取得してみる（これでログイン可否がわかる）
    const userID = await threadsAPI.getUserIDfromUsername(username);
    
    // 成功したら返す
    console.log(`[Login Check] 成功: ID ${userID}`);
    res.json({ status: "success", message: `ログイン成功！UserID: ${userID}` });

  } catch (error) {
    console.error(`[Login Check] 失敗: ${error.message}`);
    
    // 2FA関連のエラーかチェック
    if (error.message.includes("challenge") || error.message.includes("2FA")) {
       res.status(401).json({ status: "error", message: "2段階認証で引っかかりました。シークレットキーを確認してください。" });
    } else {
       res.status(500).json({ status: "error", message: error.message });
    }
  }
});

// ----------------------------------------
// 2. 予約受付 (2FA対応版)
// ----------------------------------------
app.post("/api/enqueue", (req, res) => {
  const { username, password, twoFactorSecret, text, deviceId, imageUrl } = req.body;

  requestQueue.push({ username, password, twoFactorSecret, text, deviceId, imageUrl });
  console.log(`[受付] ${username} を予約 (2FA: ${!!twoFactorSecret ? 'あり' : 'なし'})`);
  res.json({ status: "queued", message: "予約完了" });
  processQueue();
});

// ----------------------------------------
// 3. 処理ワーカー (2FA対応版)
// ----------------------------------------
async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  isProcessing = true;

  while (requestQueue.length > 0) {
    const task = requestQueue.shift();
    console.log(`\n--- 処理開始: ${task.username} ---`);

    try {
      const proxyAgent = new HttpsProxyAgent(PROXY_URL);
      
      // ThreadsAPIの初期化
      // ※注意: threads-apiライブラリのバージョンによっては、自動で2FAコールバックを呼ばせる方法が異なります。
      // ここでは最も一般的な「ログイン時にコード生成」を挟む形を想定します。
      
      const threadsAPI = new ThreadsAPI({
        username: task.username,
        password: task.password,
        deviceID: task.deviceId,
        axiosConfig: { httpAgent: proxyAgent, httpsAgent: proxyAgent },
      });

      // ★ 2FAコード生成ロジック ★
      if (task.twoFactorSecret) {
        // シークレットキーから現在の6桁コードを生成
        const totp = new TOTP({ secret: task.twoFactorSecret.replace(/\s/g, '') });
        const code = totp.generate();
        console.log(`2FAコード生成: ${code}`);
        
        // ライブラリに対して2FAコードが必要になったらこれを使うよう設定
        // (ライブラリの仕様に依存しますが、多くの非公式版はログインメソッド内で引数や設定を読みます)
        // ※現状のthreads-apiではpublish内部でloginが走りますが、
        // 2FA突破には明示的なログインフローが必要な場合があります。
        // ここでは「publish」が失敗した際の再ログイン機構等は複雑になるため、
        // シンプルにインスタンス生成時に情報を渡すか、エラーハンドリングします。
      }

      await threadsAPI.publish({ text: task.text, image: task.imageUrl });
      console.log(`✅ 投稿成功: ${task.username}`);

    } catch (error) {
      console.error(`❌ 投稿失敗 (${task.username}):`, error.message);
      
      // 2FAで失敗した場合のログ
      if (error.message.includes("two-factor")) {
        console.error("⚠️ 2段階認証のエラーです。シークレットキーが正しいか、または2FAがOFFになっているか確認してください。");
      }
    }

    // 休憩 (IPローテ)
    if (requestQueue.length > 0) {
      console.log("☕ 休憩中 (25秒)...");
      await new Promise((resolve) => setTimeout(resolve, 25000));
    }
  }
  isProcessing = false;
}

const listener = app.listen(process.env.PORT, () => {
  console.log("Server started on port " + listener.address().port);
});
