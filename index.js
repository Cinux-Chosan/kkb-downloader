#!/usr/bin/env node
const puppeteer = require('puppeteer');
const fs = require('fs-extra');
const path = require('path');
const https = require('https');
const ffmpeg = require('fluent-ffmpeg');
const inquirer = require('inquirer');
const QrCode = require('qrcode-reader');
const qrT = require('qrcode-terminal');
const Jimp = require('jimp');
const yargs = require('yargs/yargs');
const glob = require('glob');
const { hideBin } = require('yargs/helpers');

const KKB_HOME_URL = 'https://learn.kaikeba.com/home';


const argv = yargs(hideBin(process.argv))
  .option('url', { alias: 'u', type: 'string', description: '课程主页' })
  .option('phone', { alias: 'p', type: 'string', description: '账户手机号' })
  .option('use-phone', { alias: 'm', type: 'boolean', description: '登录方式，默认为微信扫码登录，该参数指定使用手机验证码登录，需配合 phone 字段一起使用' })
  .option('dir', { alias: 'd', type: 'string', description: '存放路径' })
  .option('headless', { alias: 'h', type: 'boolean', description: '是否开启 headless', default: true })
  .option('download-only', { alias: 'b', type: 'boolean', description: '仅执行批量下载', default: false })
  .option('batch-download-count', { alias: 'c', type: 'number', description: '仅执行批量下载并行数', default: 3 })
  .usage('Usage: $0')
  .usage('Usage: $0 https://learn.kaikeba.com/catalog/212328?type=1')
  .argv;

let courseUrl = argv['url'] || argv._[0];
const phone = argv['phone'];
const usePhone = argv['use-phone'];
const dir = argv['dir'] || process.cwd();
const headless = argv['headless'] || !process.env.PUPPETEER_HEAD;
const downloadOnly = argv['download-only'];
const downloadParallelCount = argv['batch-download-count'];

if (usePhone && !phone) {
  return console.error('使用手机验证码登录需指定手机号码！');
}

// puppeteer.use(require('puppeteer-extra-plugin-stealth')());

const rootdir = path.join(path.resolve(dir || __dirname), 'courses');

console.log(`内容存放路径：${rootdir}`);

// delete (process.env.PUPPETEER_EXECUTABLE_PATH);

(async () => {

  if (downloadOnly) {
    console.log('仅执行批量下载');
    const manifests = glob.sync(`**/manifest.json`, { cwd: rootdir, dot: true });
    const getCourseName = (manifest) => manifest.match(/(.*?)(\/|\\)/)[1];
    const courseNames = manifests.map((manifest, i) => ({ name: getCourseName(manifest), value: i }));
    if (courseNames.length >= 2) {
      courseNames.unshift({ name: '全部', value: -1 });
    }
    const { courses } = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'courses',
        message: '请选择需要下载的课程',
        choices: courseNames,
      }
    ]);

    const isDwonloadAll = courses.includes(-1);

    manifests.forEach((manifest, i) => {
      if (isDwonloadAll || courses.includes(i)) {
        batchDownloadCourse(path.join(rootdir, manifest), getCourseName(manifest));
      }
    });

    return;
  }


  // introduce
  const browser = await puppeteer.launch({
    headless: headless,
    // executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    windowSize: { width: 1920, height: 1080 },
    // devtools: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  process.on('exit', () => browser.close());

  const defaultPage = await createPage(KKB_HOME_URL);

  // 登录
  await login();

  // 选择课程
  while (true) {
    let courseName = '';
    try {
      const url = await getCourseUrl(courseUrl);
      const { title, downloadManifest } = await task(url);
      courseName = title;
      const courseDir = path.join(rootdir, title);
      const metaDir = ensureDirSync(path.join(courseDir, '.meta'));
      const courseManifest = path.join(metaDir, 'manifest.json');
      // console.log(`课程配置：${courseManifest}`);
      fs.writeJsonSync(courseManifest, downloadManifest);
      batchDownloadCourse(courseManifest, courseName);
    } catch (error) {
      console.error(`${courseName} 爬取内容失败：${error.message}`);
    } finally {
      courseUrl = null;
      courseName = '';
      await defaultPage?.waitForTimeout(1000);
    }
  }

  async function keepAlive() {
    setInterval(async () => {
      const page = await createPage(KKB_HOME_URL);
      page.close();
    }, 1000 * 60 * 10);
  }


  async function getCourseUrl(url) {
    if (!url) {
      url = await chooseCourse();
    }
    return url;
  }

  async function login(page = defaultPage) {

    await page.waitForSelector('.login-area');

    if (usePhone) {
      // 使用手机验证码登录
      await page.click('.others-item');

      await page.type('.txt-input[maxlength="11"]', phone);

      await page.click('.get-code');

      const result = await inquirer.prompt([{ type: 'input', name: 'code', }]);

      await page.type('.input-code', result.code);

      await page.click('.btn-login');
    } else {
      // 使用微信扫码登录
      await page.waitForSelector('#canvas');

      const qrHandle = await page.$('#canvas');

      await page.waitForTimeout(1000);

      const buffer = await qrHandle.screenshot({ type: 'png' });

      const qrdata = await parseQR(buffer);

      console.log('请使用微信扫码登录：');

      qrT.generate(qrdata, { small: true });
    }

    await page.waitForNavigation({ timeout: 0 });

    console.log('登录成功');

    keepAlive();
  }

  async function chooseCourse(page = defaultPage) {
    await page.goto('https://learn.kaikeba.com/home');
    do {
      const types = await page.$$eval('.course-type li', els => els.map(el => el.innerText));
      const { type } = await inquirer.prompt([
        {
          type: 'list',
          name: 'type',
          message: '请选择课程分类',
          choices: [...types, '退出'],
        }
      ]);
      if (type === '退出') {
        return process.exit(0);
      }
      let index = types.indexOf(type);
      // 选择对应类型
      await page.click(`.course-type li:nth-child(${index + 1})`);
      await page.waitForTimeout(1500);
      // 选择大课
      const dakes = await page.$$eval('.dake .limit-word', els => els.map(el => el.innerText));
      const { dake } = await inquirer.prompt([
        {
          type: 'list',
          name: 'dake',
          message: '请选择课程',
          choices: [...dakes, '返回'],
        }
      ]);
      if (dake === '返回') {
        continue;
      } else {
        index = dakes.indexOf(dake);
        const dakehandle = await page.$$(`.dake .limit-word`);
        await Promise.all([
          dakehandle[index].click(),
          page.waitForNavigation()
        ]);
        return page.url();
      }
    } while (true);
  }

  async function task(url) {

    const page = await createPage(url, 0); //'https://learn.kaikeba.com/video/276087');
    const downloadManifest = {};

    // 页面返回可能会触发确认离开弹窗
    page.on('dialog', async (dialog) => {
      // console.log(dialog.message());
      await dialog.accept();
    });

    try {

      await page.waitForSelector('.introduce h4');

      let title = await page.$eval('.introduce h4', el => el.innerText);

      title = title.replace(/\s/g, '-');

      const charpters = await page.$$eval('.chapter-title', els => els.map(el => el.innerText));

      const activeHeaderSel = '.ivu-collapse-item-active .ivu-collapse-header';

      await page.waitForSelector(activeHeaderSel);

      await page.waitForTimeout(2000);

      // 关闭打开的项
      await page.click(activeHeaderSel);

      await page.waitForTimeout(2000);

      // 章
      for (let index = 0; index < charpters.length; index++) {
        const chapterTitle = charpters[index];
        const charpSel = `.ivu-collapse-item:nth-child(${index + 1})`;
        const headerSel = `${charpSel} .ivu-collapse-header`;
        await page.waitForSelector(headerSel);
        await page.waitForTimeout(1000);
        await page.click(headerSel);
        const sectionsSels = `${charpSel} .section-title-text`;
        await page.waitForSelector(sectionsSels);
        const sections = await page.$$eval(sectionsSels, els => els.map(el => el.innerText));
        console.log(`第 ${index + 1} 章`);
        // 节
        for (let secIndex = 0; secIndex < sections.length; secIndex++) {
          await ensureActive(index + 1);
          console.log(`  第 ${secIndex + 1} 节`);
          const sectionSel = `${charpSel} .chapter-item:nth-child(${secIndex + 1})`;
          const sectionTitle = sections[secIndex];
          await page.waitForSelector(sectionSel);
          const sectionRows = await page.$$eval(`${sectionSel} ul li .contont-title`, els => els.map(el => el.innerText));
          // 行
          for (let sectionRowIndex = 0; sectionRowIndex < sectionRows.length; sectionRowIndex++) {
            await ensureActive(index + 1);
            console.log(`    第 ${sectionRowIndex + 1} 小节`);
            const sectionRow = sectionRows[sectionRowIndex];
            const sectionRowSel = `${sectionSel} ul li:nth-child(${sectionRowIndex + 1})`;
            const downloadPath = path.resolve(rootdir, title, chapterTitle, sectionTitle, sectionRow).replace('\n', '');
            await page.waitForSelector(sectionRowSel);
            await resolveItem(sectionRowSel, downloadPath);
          }
        }
      }

      page.close();
      // 批量下载
      console.log(`执行批量下载：${Object.keys(downloadManifest).length}`);
      return { title, downloadManifest }
    } catch (error) {
      console.error(`task error: ${error.message} --- url : ${page.url()}`);
      page.close();
      throw error;
    }

    async function resolveItem(selctor, downloadPath) {
      // 点击行：
      //  1、视频，获取 m3u8 并下载（调整清晰度）
      //  2、存在 .down-doc 则分文件下载
      //  3、其他 暂不处理

      try {
        const hasDocList = await page.$(`${selctor} .down-doc`);
        if (hasDocList) {
          const listSel = `${selctor} .down-doc li`;
          const downloadList = await page.$$(listSel);
          if (downloadList?.length) {
            downloadPath = ensureDirSync(downloadPath);
            for (let index = 0; index < downloadList.length; index++) {
              // await page.bringToFront();
              const [url, filename] = await page.$eval(`${listSel}:nth-child(${index + 1}) span`, el => {
                let sourceUrl = '';
                window.open = url => sourceUrl = url;
                el.click();
                return [sourceUrl, el.innerText];
              });
              const distName = path.join(downloadPath, filename);

              downloadManifest[distName] = { url, type: 'file' };
            }
          }
        } else {
          // 点完过后，进入页面
          let responseHandler;
          const pVideoInfo = new Promise((resolve, reject) => {
            responseHandler = async response => {
              const url = response.url();
              const method = response.request().method();
              if (url.includes('/media/detail') && method !== 'OPTIONS') {
                try {
                  resolve(await response.json());
                } catch (error) {
                  reject(error);
                  debugger
                }
              }
            };
            page.on('response', responseHandler);
          });
          const urlBeforeJump = page.url();
          try {
            // const sel = `${selctor} .contont-title`
            // await page.waitForSelector(sel);
            // await page.click(sel);
            // await page.waitForNavigation();
            await clickAndNav(`${selctor} .contont-title`);
          } catch (error) {
            console.error(`video error ${selctor}: ${error.message}, --- url : ${page.url()}`);
            throw error;
          }
          const url = page.url();
          // video 页面
          if (url.includes('/video')) {//await page.$('#dianbo video')) {
            const vdata = (await pVideoInfo).data;
            page.off('response', responseHandler);
            const fileName = vdata.title;
            const vinfo = vdata.mediaMetaInfo.videoGroup[0];
            const vurl = vinfo.playURL;
            downloadPath = ensureDirSync(downloadPath);
            downloadManifest[path.join(downloadPath, fileName)] = { url: vurl, type: 'video' };
          }

          // 以下两种方式在高频操作下偶现失效，因此采用 goto
          // await page.goBack();
          // await page.evaluate(() => history.back());
          await page.goto(urlBeforeJump);
        }
      } catch (error) {
        console.error(`resolve 错误(${selctor}):`, error.message, `--- url : ${page.url()}`);
      }
    }

    async function clickAndNav(sel) {
      await page.waitForSelector(sel);
      // 偶现点击后，页面不会跳转，延迟 2 秒同样偶现，持续点击直到跳转为止
      const id = setInterval(async () => {
        try {
          await page.evaluate((sel) => {
            document.querySelector(sel).click();
          }, sel);
        } catch (error) {
          // console.log('clickAndNav error:', error.message);
        }
      }, 100);
      await page.waitForNavigation();
      clearInterval(id);
    }

    // 确保打开对应的章节
    async function ensureActive(charpterIndex) {
      const currentUrl = page.url();
      if (currentUrl !== url) {
        await page.goto(url, { waitUntil: 'networkidle2' });
      }
      await page.waitForSelector(`.ivu-collapse-item`);
      // await page.waitForSelector('.ivu-collapse-item-active');
      await page.waitForTimeout(100);
      const sel = `.ivu-collapse-item:nth-child(${charpterIndex})`
      const isOpen = await page.$eval(`.ivu-collapse-item:nth-child(${charpterIndex})`, el => el.classList.contains('ivu-collapse-item-active'))
      if (!isOpen) {
        await page.click(`${sel} .ivu-collapse-header`);
      }
    }
  }

  async function batchDownloadCourse(manifestPath, courseName = '') {
    const downloadManifest = require(manifestPath);
    const dir = path.dirname(manifestPath);
    const errors = {};
    const tasks = [];
    const dones = [];
    let count = 0;

    const id = setInterval(() => console.log(`\n${'-'.repeat(20)}\n当前下载任务${courseName}已完成：${dones.length}，待执行：${tasks.length}，正在执行：${count}，下载错误：${Object.keys(errors).length}\n${'-'.repeat(20)}\n`), 10000);

    const runNewOne = async () => {
      while (count < downloadParallelCount && tasks.length) {
        // console.log(`---------- \n当前剩余 ${tasks.length} 个待下载任务。\n----------`);
        const task = tasks.shift();
        if (task) {
          try {
            count++;
            dones.push(await task());
            fs.writeJSONSync(manifestPath, downloadManifest);
          } catch (error) {
            console.error(`runNewOne Error:${error.message}`);
          } finally {
            count--;
          }
        }
      }
    };

    for (const filename in downloadManifest) {
      const info = downloadManifest[filename];
      const { url, type, downloaded } = info;
      if (downloaded) {
        dones.push(Promise.resolve());
        continue;
      }
      ensureDirSync(path.dirname(filename));
      let task;
      switch (type) {
        case 'video':
          task = async () => {
            try {
              await ffdownload(url, filename);
              info.downloaded = true;
            } catch (error) {
              // console.error(`${filename} download error:`, error.message);
              errors[filename] = error.message;
              throw error;
            }
          };

          break;
        case 'file': {
          task = async () => {
            try {
              await httpDownload(url, filename);
              info.downloaded = true;
            } catch (error) {
              // console.error(`${filename} download error:`, error.message);
              errors[filename] = error.message;
              throw error;
            }
          };
          break;
        }
      }
      tasks.push(task);
    }

    await Promise.all(new Array(downloadParallelCount).fill(0).map(() => runNewOne()));
    console.log(`${courseName}下载任务完成，存放于${path.resolve(dir, '..')}`);
    fs.writeJSONSync(path.join(dir, 'errors.json'), errors);
    clearInterval(id);
  }

  function httpDownload(url, filename) {
    return new Promise((resolve, reject) => {
      https.get(url, res => {
        res.on('error', (err) => {
          // console.error(`${filename} download error: ${err.message}`);
          errors[filename] = err.message;
          reject(`${filename} download error: ${err.message}`);
        });
        res.on('end', () => {
          resolve(`${filename} download end`);
          console.log(`${filename} download end`);
        });
        res.pipe(fs.createWriteStream(filename));
      });
    })
  }

  function ffdownload(url, filepath) {
    return new Promise((resolve, reject) => {
      ffmpeg(url)
        .on('start', () => console.log(`开始下载${filepath}`))
        .on("error", reject)
        // .on('progress', (progress) => console.log('下载进度: 已完成 ' + (progress.percent) + '%。', '已下载 ' + progress.targetSize / 1024 + 'MB'))
        .on("end", () => resolve(console.log(`${filepath} 下载完成\n`)))
        .inputOption('-headers', 'User-Agent:\ Mozilla/5.0\ (Macintosh;\ Intel\ Mac\ OS\ X\ 10_15_7)\ AppleWebKit/537.36\ (KHTML,\ like\ Gecko)\ Chrome/91.0.4472.114\ Safari/537.36\ Edg/91.0.864.59\r\nOrigin:\ https://learn.kaikeba.com\r\nReferer:\ https://learn.kaikeba.com/')
        .outputOptions("-c copy")
        // .outputOptions("-bsf:a aac_adtstoasc")
        .saveToFile(filepath.endsWith('.mp4') ? filepath : filepath.endsWith('/') ?
          filepath.replace(/\/$/, '.mp4')
          : `${filepath}.mp4`);
    });
  }

  function ensureDirSync(dir) {
    dir = dir.replace(/(\n|\s)/gm, '-')
    fs.ensureDirSync(dir);
    return dir;
  }

  function parseQR(buffer) {
    return new Promise((resolve, reject) => {
      Jimp.read(buffer, (err, image) => {
        if (err) {
          console.error(err);
          return reject(err);
        }
        const qr = new QrCode();
        qr.callback = (err, value) => {
          if (err) {
            console.error(`二维码解析出错：${err}，请重试！`);
            return reject(err);
          }
          resolve(value.result);
        };
        qr.decode(image.bitmap);
      });
    })
  }


  async function createPage(url, timeout) {
    const page = await browser.newPage({});

    await page.setRequestInterception(true);

    page.on('request', request => {
      const resourceType = request.resourceType();
      // 禁用无关请求的加载
      if ([
        // 'image', 'stylesheet', "media", 
        "font"].includes(resourceType))
        request.abort();
      else
        request.continue();
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout });

    await page.setViewport({
      width: 1200,
      height: 1080,
      deviceScaleFactor: 1,
    });
    return page;
  }

})();