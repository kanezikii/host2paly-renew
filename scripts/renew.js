const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const rawUrls = process.env.RENEW_URLS || '';
const TARGET_URLS = rawUrls.split(/[\n,;]+/).map(u => u.trim()).filter(u => u.startsWith('http'));
const PROXY_JSON = process.env.PROXY_JSON;

const EXTENSION_PATH = path.join(__dirname, 'extensions', 'nopecha', 'unpacked');

async function startProxy() {
    console.log('[初始化] 准备 Hysteria2 代理配置...');
    fs.writeFileSync('config.json', PROXY_JSON);

    console.log('[Hysteria2] starts...');
    const hysteria = spawn('hysteria', ['-c', 'config.json']);
    
    hysteria.stdout.on('data', (data) => console.log(`[Hysteria2 Log]: ${data}`));
    hysteria.stderr.on('data', (data) => console.error(`[Hysteria2 Error]: ${data}`));

    await new Promise(resolve => setTimeout(resolve, 5000));
    console.log('[Hysteria2] socks5: 127.0.0.1:10808 预计已就绪');
    return hysteria;
}

async function run() {
    if (TARGET_URLS.length === 0) {
        console.error('[错误] 未找到任何有效的续期链接，请检查 Github Secrets 中的 RENEW_URLS 是否配置正确！');
        return;
    }

    let proxyProcess;
    if (PROXY_JSON) {
        proxyProcess = await startProxy();
    }

    console.log('[Playwright] 启动中，并注入伪装特征...');
    const userDataDir = '/tmp/playwright_user_data';
    
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false, 
        proxy: { server: 'socks5://127.0.0.1:10808' },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        args: [
            `--disable-extensions-except=${EXTENSION_PATH}`,
            `--load-extension=${EXTENSION_PATH}`,
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--ignore-certificate-errors'
        ]
    });

    const page = await context.newPage();
    
    // 给 NopeCHA 插件几秒钟初始化时间，并关闭可能弹出的欢迎页，防止焦点丢失
    await page.waitForTimeout(3000);
    for (const p of context.pages()) {
        if (p !== page && p.url().includes('nopecha')) {
            await p.close();
        }
    }

    console.log(`[浏览器] 启动完成，共检测到 ${TARGET_URLS.length} 个续期任务...`);

    for (let i = 0; i < TARGET_URLS.length; i++) {
        const url = TARGET_URLS[i];
        const taskNum = i + 1; 
        
        console.log(`\n======================================================`);
        console.log(`[任务 ${taskNum}/${TARGET_URLS.length}] 正在处理链接: ${url}`);
        console.log(`======================================================`);

        try {
            console.log(`[任务 ${taskNum}] 访问公开续期链接...`);
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(5000); 

            const isLoading = await page.locator('text="Loading..."').isVisible();
            if (isLoading) {
                console.log(`[任务 ${taskNum} 警报] 页面卡在 Loading，尝试强制刷新突破...`);
                await page.reload({ waitUntil: 'domcontentloaded' });
                await page.waitForTimeout(8000); 
            }

            console.log(`[任务 ${taskNum} 交互] 查找并点击蓝色的 "Renew server" 按钮...`);
            const initialRenewBtn = page.locator('text="Renew server"').first();
            if (await initialRenewBtn.isVisible()) {
                await initialRenewBtn.click();
            } else {
                console.log(`[任务 ${taskNum} 警告] 没找到蓝色的 Renew server 按钮。`);
            }

            await page.waitForTimeout(2000);

            console.log(`[任务 ${taskNum} 交互] 查找二次确认的紫色 Renew 按钮...`);
            const modalRenewBtn = page.locator('button:text-is("Renew")').first();
            
            if (await modalRenewBtn.isVisible()) {
                await modalRenewBtn.click();
                console.log(`[任务 ${taskNum} 交互] 已点击紫色 Renew，验证码正式弹出！`);
            } else {
                console.log(`[任务 ${taskNum} 警告] 未找到紫色的 Renew 弹窗按钮。`);
            }

            // 延长等待时间至 60 秒，确保 NopeCHA 有充足的时间处理复杂的图片验证码
            console.log(`[任务 ${taskNum} 交互] 等待 NopeCHA 处理图片验证码 (给予 60 秒时间)...`);
            await page.waitForTimeout(60000); 

            await page.screenshot({ path: path.join(__dirname, 'screenshots', `4_final_result_${taskNum}.png`), fullPage: true });
            console.log(`[任务 ${taskNum} 截图] 流程结束，请查看 4_final_result_${taskNum}.png 确认时间是否已刷新。`);

        } catch (error) {
            console.error(`[任务 ${taskNum} 错误] 运行中断:`, error);
            await page.screenshot({ path: path.join(__dirname, 'screenshots', `error_crash_${taskNum}.png`), fullPage: true });
        }
    } 

    await context.close();
    if (proxyProcess) proxyProcess.kill();
    console.log('\n[全部结束] 所有续期任务执行完毕，清理进程。');
}

run();
