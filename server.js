const express = require("express");
const puppeteer = require("puppeteer");
const app = express();

app.use(express.json());

const requestQueue = [];
let isProcessing = false;

// ---------------------------------------------------------
//  Cookie解析
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
            domain: ".threads.net",
            path: "/",
            secure: true,
            httpOnly: c.httpOnly !== undefined ? c.httpOnly : true
          });
        });
      }
    } catch (e) { console.error("Cookie JSON解析エラー:", e); }
  } else {
    // 文字列の場合
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
//  ★修正: プロキシ情報を分解する関数
// ---------------------------------------------------------
function parseProxy(proxyStr) {
  if (!proxyStr) return null;
  
  // ADSPOWER形式 (host:port:user:pass)
  if (!proxyStr.startsWith("http")) {
    const parts = proxyStr.split(':');
    if (parts.length === 4) {
      return {
        server: `${parts[0]}:${parts[1]}`, // host:port
        username: parts[2],
        password: parts[3]
      };
    }
  }
  
  // URL形式 (http://user:pass@host:port)
  try {
    const url = new URL(proxyStr.startsWith("http") ? proxyStr : `http://${proxyStr}`);
    return {
      server: `${url.hostname}:${url.port}`,
      username: url.username,
      password: url.password
    };
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------
//  メイン処理
// ---------------------------------------------------------
async function runPuppeteerPost(task) {
  let browser = null;
  try {
    console.log("🚀 ブラウザ起動準備...");
    
    // プロキシ情報の分解
    const proxyData = parseProxy(task.proxy);
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--single-process',
      '--no-zygote',
      '--disable-notifications'
    ];

    // ★修正: プロキシサーバーの設定 (ID/PASSはここでは入れない)
    if (proxyData) {
      args.push(`--proxy-server=${proxyData.server}`);
      console.log(`🌐 プロキシ設定: ${proxyData.server}`);
    }

    browser = await puppeteer.launch({
      args: args,
      headless: "new"
    });

    const page = await browser.newPage();

    // ★修正: ここでプロキシ認証を行う
    if (proxyData && proxyData.username) {
      await page.authenticate({ 
        username: proxyData.username, 
        password: proxyData.password 
      });
      console.log("🔑 プロキシ認証設定完了");
    }

    // UA偽装
    await page.setUserAgent(task.ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36");

    // Cookieセット
    const cookies = parseCookies(task.fullCookie);
    if (cookies.length > 0) {
      await page.setCookie(...cookies);
      console.log(`🍪 Cookie ${cookies.length}個をセットしました`);
    }

    // Threadsへアクセス
    console.log("🌍 Threadsにアクセス中...");
    // タイムアウトを長めに設定 (プロキシ経由は遅いことがあるため)
    await page.goto("https://www.threads.net/", { waitUntil: 'networkidle2', timeout: 90000 });

    // ログイン確認
    // 投稿エリアを探す
    const postInputSelector = 'div[data-lexical-editor="true"], div[role="textbox"]';
    
    // ログインしていないと "Log in" ボタンなどが出るはず
    // 投稿エリアが出るまで待つ
    try {
      await page.waitForSelector(postInputSelector, { timeout: 20000 });
      console.log("✅ ログイン確認OK (投稿エリア発見)");
    } catch (e) {
      // デバッグ用: 画面のタイトルなどを出す
      const title = await page.title();
      console.log(`⚠️ 投稿エリアが見つかりません。現在のタイトル: ${title}`);
      throw new Error("ログイン状態を確認できませんでした。Cookieが無効か、プロキシが遅すぎてタイムアウトしました。");
    }

    // クリックして入力
    await page.click(postInputSelector);
    await new Promise(r => setTimeout(r, 2000));

    console.log("✍️ テキスト入力中...");
    await page.type(postInputSelector, task.text, { delay: 100 });
    await new Promise(r => setTimeout(r, 3000));

    // 「投稿」ボタンを探してクリック
    // 文字列が含まれる要素を探すXPathを使用
    const [button] = await page.$x("//div[@role='button'][contains(., 'Post') or contains(., '投稿')]");
    
    if (button) {
      console.log("🔘 投稿ボタンをクリック...");
      await button.click();
      await new Promise(r => setTimeout(r, 8000)); // 完了待ち
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

// 1. ログイン確認 (簡易)
app.post("/api/check", async (req, res) => {
  res.json({ status: "success", message: "★Puppeteerサーバー稼働中！「投稿」を実行してください。" });
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
      await runPuppeteerPost(task);
    } catch (error) {
      console.error(`❌ 投稿失敗 (${task.username}):`, error.message);
    }

    if (requestQueue.length > 0) {
      console.log("☕ 休憩中...");
      await new Promise((resolve) => setTimeout(resolve, 30000));
    }
  }
  isProcessing = false;
}

const listener = app.listen(process.env.PORT, () => {
  console.log("Server started");
});
