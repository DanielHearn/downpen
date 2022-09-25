#!/usr/bin/env node

import dateFormat from "dateformat";
import fs from 'fs';
import puppeteer from 'puppeteer';
import path from 'path';

const siteUrl = 'https://codepen.io/';
const args = process.argv.slice(2);
const now = new Date();
const formattedDate = dateFormat(now, 'dd_mm_yyyy_HH-MM');
const maxRetries = 4;

let username = null;
let password = null;
let userDir = null;
let browser = null;
let page = null;
let downloadedPens = [];
let erroredPens = [];

initialize()

async function initialize () {
  console.log('Running downpen downloader')
  if (args.length === 2) {
    username = args[0];
    password = args[1];
    userDir = `./downloaded/${username}/${formattedDate}/`;
    console.log(`Check if Codepen user '${username}' exists`);
    console.log('A chromium browser will open during the download process')
    browser = await puppeteer.launch({
      headless: false,
      slowMo: 100,
    });
    page = await browser.newPage();
    page.setDefaultTimeout(10000)

    const userPage = getUserPageUrl(username)
    const userExists = await checkUserPage(userPage);
    if (!userExists) {
      console.error(`Username ${username} does not exist on Codepen`);
      await browser.close();
      return false;
    }
    console.log(`Username ${username} exists`)

    const loggedIn = await login(username, password)
    if (!loggedIn) {
      console.error(`Failed to login as ${username}`);
      await browser.close();
      return false;
    }
    console.log(`Logged in as ${username}`)
    await page.goto(userPage, {
      waitUntil: 'networkidle2',
    });
    await downloadPens(username)
    await page.waitForTimeout(20000);
    await browser.close();
  } else {
    console.error('Missing Codepen username, email, password within arguments');
    return false;
  }
}

function getUserPageUrl (username) {
  return `${siteUrl}${username}/pens/public?grid_type=list`;
}

async function checkUserPage (userPageUrl) {
  await page.goto(userPageUrl, {
    waitUntil: 'networkidle2',
  });
  const exists = await page.$eval('.profile-grid-pens', () => true).catch(() => false);
  return exists;
}

async function login () {
  await page.goto('https://codepen.io/login', {
    waitUntil: 'networkidle2',
  });
  const emailSelector = '#login-email-field';
  const passSelector = '#login-password-field';
  await page.waitForSelector(emailSelector);
  await page.focus(emailSelector);
  await page.keyboard.type(username);
  await page.focus(passSelector);
  await page.keyboard.type(password);
  await page.click('#log-in-button');
  await page.waitForTimeout(5000);
  await page.waitForSelector('.logged-in');

  const totalPens = downloadPens.length + erroredPens.length;
  console.log(`Successfully downloaded ${downloadPens.length}/${totalPens}`)

  return true;
}

async function checkFolderExists (dir) {
  try {
    if (fs.existsSync(dir)) {
      return true;
    } else {
      makeFolder(dir);
      return true;
    }
  } catch (e) {
    makeFolder(dir);
    return true;
  }
}

async function makeFolder (dir) {
  fs.mkdirSync(dir);
}

async function initializeFolders () {
  await checkFolderExists('downloaded');
  await checkFolderExists(`downloaded/${username}`);
  await checkFolderExists(userDir);
}

async function downloadPens () {
  await initializeFolders();
  await page.waitForTimeout(5000);
  let nextPageAvailable = true;
  let pageNumber = 1;
  while(nextPageAvailable) {
    console.log(`Downloading from page ${pageNumber}`);
    nextPageAvailable = await page.$eval('[data-direction="next"]', () => true).catch(() => false);
    const elements = await page.$$(".profile-grid-pens tr .title a");
    const links = [];
    for (const element of elements) {
      const link = await (await element.getProperty('href')).jsonValue();
      links.push(link);
    }

    console.log(`Found ${links.length} pens on page ${pageNumber}`);
    let sequence = Promise.resolve();
    links.forEach(link => {
      sequence = 
        sequence
          .then(async () => {
            const id = link.split('/').pop()
            let retries = 1;
            let success = false
            while (retries < maxRetries && !success) {
              retries++
              const result = await downloadPen(link)
              if (result) {
                success = true
                downloadedPens.push(id)
              } else {
                console.log(`Retrying download for ${link}, attempt ${retries}`)
              }
            }

            if (retries === maxRetries) {
              erroredPens.push(id)
            }

            return true
            
    }) ;
    });

    await sequence;

    if (nextPageAvailable) {
      console.log('Next page available');
      await page.waitForTimeout(2000);
      await page.click('[data-direction="next"]');
      await page.waitForTimeout(2000);
      pageNumber++;
    } else {
      console.log('Finished downloading, no more pages available');
    }
  }

  return true
}

async function downloadPen (url) {
  const penPage = await browser.newPage();
  try {
    console.log(`Attempting download for: ${url}`);
    penPage.setDefaultTimeout(10000);
    const client = await penPage.target().createCDPSession(); 
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      userDataDir: './',
      downloadPath: path.resolve(userDir)
    });
    await penPage.goto(url, {
      waitUntil: 'networkidle2',
    });
    const linkHandlers = await penPage.$x("//button[contains(text(), 'Export')]");
    if (linkHandlers.length > 0) {
      console.log(`Found export link for: ${url}`);
      await linkHandlers[0].click();
      await penPage.click('[data-test-id="export-zip"]');
      await penPage.waitForTimeout(3000);
      await penPage.close();
      return true;
    } else {
      console.log(`No export link for: ${url}`);
      await penPage.close();
      return false;
    }
  } catch (err) {
    console.log(`Failed export for ${url}`);
    console.log(err);
    await penPage.close();
    return false;
  }
}
