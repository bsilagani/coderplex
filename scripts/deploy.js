#! /usr/bin/env node
/* eslint-disable camelcase */

const path = require('path');
const fs = require('fs');

const github = require('octonode');
const travisAfterAll = require('travis-after-all');
const urlRegex = require('url-regex');
const normalizeUrl = require('normalize-url');
const axios = require('axios');

const argv = require('yargs')
  .option('debug', {
    alias: 'd',
    description: 'Show debug info',
    type: Boolean,
  })
  .option('public', {
    alias: 'p',
    description: 'Deployment is public (`/_src` is exposed)',
    type: Boolean,
  })
  .option('team', {
    alias: 'T',
    description: 'Set a custom team scope',
    type: String,
  })
  .option('folder', {
    alias: 'F',
    description: 'Set a folder to deploy',
    type: String,
  })
  .option('comment', {
    alias: 'c',
    description:
      'Post a comment to the PR issue summarizing the now deployment results',
    default: true,
    type: Boolean,
  })
  .help()
  .alias('help', 'h').argv;

const { runNow, runNowAlias } = require('./now');

if (!process.env.CI || !process.env.TRAVIS) {
  throw new Error('Could not detect Travis CI environment');
}

const githubToken = process.env.GH_TOKEN;
const nowToken = process.env.NOW_TOKEN;
const discordHook = process.env.DISCORD_HOOK;
const repoSlug = process.env.TRAVIS_REPO_SLUG;
const aliasUrl = process.env.NOW_ALIAS;

if (!githubToken) {
  throw new Error('Missing required environment variable GH_TOKEN');
}

if (!nowToken) {
  throw new Error('Missing required environment variable NOW_TOKEN');
}

const ghClient = github.client(githubToken);
const ghRepo = ghClient.repo(repoSlug);
const ghIssue = ghClient.issue(repoSlug, process.env.TRAVIS_PULL_REQUEST);

function getUrl(content) {
  const urls = content.match(urlRegex()) || [];
  return urls.map(url => normalizeUrl(url.trim().replace(/\.+$/, '')))[0];
}

const baseArgs = ['--token', nowToken, '--name', 'coderplex-app'];

const nowArgs = ['--no-clipboard'];

if (argv.debug || argv.d) {
  baseArgs.push('--debug');
}

if (argv.team || argv.T) {
  baseArgs.push('--team');
  baseArgs.push(argv.team || argv.T);
}

if (argv.public || argv.p) {
  nowArgs.push('--public');
}

if (argv.folder || argv.F) {
  const deployPath = path.resolve(argv.folder);
  if (fs.statSync(deployPath).isDirectory()) {
    nowArgs.push('--name', repoSlug.replace('/', '-'));
    nowArgs.push(deployPath);
  }
}

function notifyInDiscord(err, res) {
  if (err) {
    return axios
      .post(discordHook, {
        username: `${repoSlug.replace('/', '-')}-BOT`,
        content: `Deploymet failed check travis logs here https://travis-ci.org/coderplex/coderplex/builds/${process
          .env.TRAVIS_BUILD_ID}#L538`,
      })
      .then(() => {
        console.log(`Error posted to discord`);
      })
      .catch(console.log.bind(console));
  }
  return axios
    .post(discordHook, {
      username: `${repoSlug.replace('/', '-')}-BOT`,
      content: buildComment(res.context, res.url, 'https://coderplex.org'),
    })
    .then(() => {
      console.log(`Success posted to discord`);
    })
    .catch(console.log.bind(console));
}

function buildComment(context, url, aliasUrl) {
  return `### New Δ Now ${context} deployment complete\n- ✅ **Build Passed**\n- 🚀 **URL** : ${aliasUrl
    ? aliasUrl
    : url}\n---\nNote: **This is autogenerated through travis-ci build**`;
}

function deploy(context, sha) {
  console.log(`context: ${context}`);
  console.log(`sha: ${sha}`);
  if (context === 'staging') {
    // Send error status to github PR
    ghRepo.status(
      sha,
      {
        context,
        state: 'pending',
        description: `Δ Now ${context} deployment pending`,
      },
      console.log.bind(console),
    );
  }
  // Initiate deployment process
  runNow([...baseArgs, ...nowArgs], (code, res) => {
    // Remember, process code: 0 means success else failure in unix/linux
    if (code) {
      if (context === 'staging') {
        // Send error status to github PR
        ghRepo.status(
          sha,
          {
            context,
            state: 'error',
            description: `Δ Now ${context} deployment failed`,
          },
          console.log.bind(console),
        );
      }
      // Notify in discord
      notifyInDiscord(true);
      return console.log(`now process exited with code ${code}`);
    }

    // Retrieve now.sh unique url from stdOut
    const deployedUrl = getUrl(res);
    console.log(`deployedUrl: ${deployedUrl}`);
    if (context === 'staging') {
      // Send success status to github PR
      ghRepo.status(
        sha,
        {
          context,
          target_url: deployedUrl,
          state: 'success',
          description: `Δ Now ${context} deployment complete`,
        },
        console.log.bind(console),
      );
      // Check and create comment on github PR abot deployment results
      ghIssue.createComment(
        {
          body: buildComment(context, deployedUrl),
        },
        console.log.bind(console),
      );
      return;
    }
    // In production alias deployment to specified alias url from now.json file or from env variable
    if (context === 'production') {
      runNowAlias(baseArgs, { deployedUrl, aliasUrl }, code => {
        if (code) {
          // Notify failure in discord.
          notifyInDiscord(true);
          return console.log(`now process exited with code ${code}`);
        }
        // Notify success in discord
        notifyInDiscord(false, { context, url: deployedUrl, aliasUrl });
        console.log('🎉 Done');
      });
    }
  });
}

travisAfterAll((code, err) => {
  if (err || code) return;
  switch (process.env.TRAVIS_EVENT_TYPE) {
    case 'pull_request':
      return deploy('staging', process.env.TRAVIS_PULL_REQUEST_SHA);
    case 'push':
      return deploy('production', process.env.TRAVIS_COMMIT);
    default:
      break;
  }
});
