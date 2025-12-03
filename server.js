const express = require("express");
const puppeteer = require("puppeteer");
const app = express();

app.use(express.json());

const requestQueue = [];
let isProcessing = false;

// ---------------------------------------------------------
//  Cookie解析 (JSONでも文字列でもOK)
// ---------------------------------------------------------
function parseCookies(input) {
  const cookies = [];
  if (!input) return cookies;
  const trimmed = input.trim();

  // JSONの場合
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        parsed.forEach(c => {
          cookies.push({
            name: c.name,
            value: c.value,
            domain: ".threads.net", // ドメインを強制指定
            path: "/",
            secure: true,
            httpOnly: c.httpOnly !== undefined ? c.httpOnly : true
          });
        });
      }
    } catch (e) { console.error("Cookie JSON解析エラー:", e); }
  } else {
    // 文字列の場合 (sessionid=...; ...)
    trimmed.split(';').forEach(part => {
      const [key, ...v] = part.trim().split('=');
      if (key && v.length > 0) {
        cookies.push({
          name: key,
          value: v.join('='),
          domain: ".threads.net",
          path: "/",
          secure: true
        });
      }
    });
  }
  return cookies;
}

// ---------------------------------------------------------
//  メイン：ブラウザを起動して投稿する処理
// ---------------------------------------------------------
async function runPuppeteerPost(task) {
  let browser = null;
  try {
    console.log("🚀 ブラウザ起動中...");
    
    // Render等のサーバーで動くための設定
    browser = await puppeteer.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--single-process',
        '--no-zygote',
        // プロキシがある場合
        task.proxy ? `--proxy-server=${task.proxy}` : ''
      ],
      headless: "new" // ヘッドレスモード（画面なし）
    });

    const page = await browser.newPage();

    // UA偽装
    await page.setUserAgent(task.ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36");

    // 1. Cookieをセット
    const cookies = parseCookies(task.fullCookie);
    if (cookies.length > 0) {
      await page.setCookie(...cookies);
      console.log(`🍪 Cookie ${cookies.length}個をセットしました`);
    } else {
      throw new Error("Cookieが空です");
    }

    // 2. Threadsを開く
    console.log("🌍 Threadsにアクセス中...");
    await page.goto("https://www.threads.net/", { waitUntil: 'networkidle2', timeout: 60000 });

    // 3. ログイン確認 (投稿エリアがあるかチェック)
    // "Start a thread..." のようなプレースホルダーやボタンを探す
    // セレクタは変わる可能性があるので、複数の候補で探す
    const postInputSelector = 'div[data-lexical-editor="true"], div[role="textbox"], div[aria-label="Start a thread..."]';
    
    try {
      await page.waitForSelector(postInputSelector, { timeout: 10000 });
      console.log("✅ ログイン確認OK（投稿エリアが見つかりました）");
    } catch (e) {
      // ログインできていない場合、ログインボタンが出ているはず
      throw new Error("ログイン状態を確認できませんでした（投稿エリアが見つからない）。Cookieが無効かIP制限です。");
    }

    // 4. 投稿エリアをクリック
    await page.click(postInputSelector);
    await new Promise(r => setTimeout(r, 1000)); // 少し待つ

    // 5. テキスト入力
    console.log("✍️ テキスト入力中...");
    // 念のためクリックしてからタイプ
    await page.type(postInputSelector, task.text, { delay: 50 }); 

    await new Promise(r => setTimeout(r, 2000)); // 入力後の待機

    // 6. 「Post」ボタンを探してクリック
    // ボタンの文字 "Post" を含む要素を探す
    const postBtn = await page.evaluateHandle(() => {
      const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
      return buttons.find(b => b.innerText.includes("Post") || b.innerText.includes("投稿"));
    });

    if (postBtn) {
      console.log("🔘 投稿ボタンをクリック...");
      await postBtn.click();
      
      // 投稿完了まで少し待つ
      await new Promise(r => setTimeout(r, 5000));
      console.log(`✅ 投稿成功: ${task.username}`);
    } else {
      throw new Error("投稿ボタンが見つかりませんでした");
    }

  } catch (error) {
    console.error(`❌ 処理失敗: ${error.message}`);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
      console.log("🔒 ブラウザを閉じました");
    }
  }
}


// 1. ログイン確認 API (Puppeteer版)
app.post("/api/check", async (req, res) => {
  const { username } = req.body;
  // この構成では「実際にブラウザを立ち上げる」のが重いため、
  // checkでは簡易的に「サーバーは生きてるよ」と返すだけにします
  // 本当のテストは「投稿」で行ってください
  console.log(`[Login Check] ${username} (Server Alive)`);
  res.json({ status: "success", message: "★サーバー稼働中！ いきなり「投稿」を試してください。" });
});

// 2. 予約受付
app.post("/api/enqueue", (req, res) => {
  const { username, fullCookie, text, deviceId, imageUrl, ua, proxy } = req.body;
  requestQueue.push({ username, fullCookie, text, deviceId, imageUrl, ua, proxy });
  console.log(`[受付] ${username} を予約`);
  res.json({ status: "queued", message: "予約完了" });
  processQueue();
});

// 3. 処理ワーカー
async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  isProcessing = true;

  while (requestQueue.length > 0) {
    const task = requestQueue.shift();
    console.log(`\n--- 処理開始 (Puppeteer): ${task.username} ---`);

    try {
      // ブラウザ操作を実行
      await runPuppeteerPost(task);

    } catch (error) {
      console.error(`❌ 投稿失敗 (${task.username}):`, error.message);
    }

    if (requestQueue.length > 0) {
      console.log("☕ 休憩中 (30秒)...");
      await new Promise((resolve) => setTimeout(resolve, 30000));
    }
  }
  isProcessing = false;
}

const listener = app.listen(process.env.PORT, () => {
  console.log("Server started");
});
