const axios = require('axios');
const fs = require('fs');
const { stringify } = require('csv-stringify');

const GITHUB_TOKEN = 'your_token_here';
const MAX_REPOS = 1000; //edit wtv number of repos u want to scrape
const PER_PAGE = 100; // how many repos per page

const api = axios.create({
  baseURL: 'https://api.github.com',
  headers: {
    Authorization: `token ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
  },
});

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function makeRequest(url, params = {}) {
  let retries = 0;
  const maxRetries = 5;
  const baseWaitTime = 1000; 

  while (true) {
    try {
      const response = await api.get(url, { params });
      const rateLimitRemaining = parseInt(response.headers['x-ratelimit-remaining']);
      const rateLimitReset = parseInt(response.headers['x-ratelimit-reset']) * 1000;

      if (rateLimitRemaining < 10) {
        const waitTime = rateLimitReset - Date.now() + 1000; // add 1 second buffer cause ratelimit sucks
        console.log(`Rate limit nearly exceeded. Waiting for ${waitTime / 1000} seconds.`);
        await sleep(waitTime);
      }

      return response.data;
    } catch (error) {
      if (error.response && error.response.status === 403) {
        if (retries < maxRetries) {
          retries++;
          const waitTime = baseWaitTime * Math.pow(2, retries); // retry with more time smh 
          console.log(`Received 403 error. Retrying in ${waitTime / 1000} seconds. Retry attempt: ${retries}`);
          await sleep(waitTime);
        } else {
          console.log(`Max retries reached for URL: ${url}. Skipping this request.`);
          return null; // throw an error
        }
      } else {
        throw error;
      }
    }
  }
}

async function fetchAllPages(url, params = {}) {
  let allData = [];
  let page = 1;

  while (true) {
    const data = await makeRequest(url, { ...params, page, per_page: 100 });
    allData = allData.concat(data);

    if (data.length < 100) break;
    page++;
  }

  return allData;
}

async function fetchRepositories() {
  const allRepos = [];
  let page = 1;

  while (allRepos.length < MAX_REPOS) {
    const data = await makeRequest('/search/repositories', {
      q: 'stars:>1',
      sort: 'stars',
      order: 'desc',
      per_page: PER_PAGE,
      page: page,
    });

    allRepos.push(...data.items);
    if (data.items.length < PER_PAGE) break;
    page++;
  }

  return allRepos.slice(0, MAX_REPOS);
}

async function main() {
  const repoCsvStream = stringify({ header: true });
  const repoWriteStream = fs.createWriteStream('github_repos.csv');
  repoCsvStream.pipe(repoWriteStream);

  const contributorCsvStream = stringify({ header: true });
  const contributorWriteStream = fs.createWriteStream('github_contributors.csv');
  contributorCsvStream.pipe(contributorWriteStream);

  const repos = await fetchRepositories();
  console.log(`Fetched ${repos.length} repositories.`);

  for (const repo of repos) {
    try {
      const languages = await makeRequest(`/repos/${repo.full_name}/languages`);
      if (languages === null) {
        console.log(`Skipping repository ${repo.full_name} due to persistent 403 error.`);
        continue;
      }

      const contributors = await fetchAllPages(`/repos/${repo.full_name}/contributors`);
      if (contributors === null) {
        console.log(`Skipping contributors for repository ${repo.full_name} due to persistent 403 error.`);
        continue;
      }

      repoCsvStream.write({
        repo_id: repo.id,
        repo_name: repo.full_name,
        repo_description: repo.description,
        repo_url: repo.html_url,
        repo_homepage: repo.homepage,
        repo_stars: repo.stargazers_count,
        repo_watchers: repo.watchers_count,
        repo_forks: repo.forks_count,
        repo_open_issues: repo.open_issues_count,
        repo_language: repo.language,
        repo_created_at: repo.created_at,
        repo_updated_at: repo.updated_at,
        repo_pushed_at: repo.pushed_at,
        repo_size: repo.size,
        repo_default_branch: repo.default_branch,
        repo_topics: repo.topics ? repo.topics.join(', ') : '',
        repo_has_issues: repo.has_issues,
        repo_license: repo.license ? repo.license.name : '',
        repo_languages: JSON.stringify(languages),
        total_contributors: contributors.length,
      });

      for (const contributor of contributors) {
        contributorCsvStream.write({
          repo_id: repo.id,
          repo_name: repo.full_name,
          contributor_id: contributor.id,
          contributor_login: contributor.login,
          contributor_type: contributor.type,
          contributor_site_admin: contributor.site_admin,
          contributor_contributions: contributor.contributions,
          contributor_url: contributor.html_url,
        });
      }

      console.log(`Processed ${repo.full_name}`);
    } catch (error) {
      console.error(`Error processing repository ${repo.full_name}:`, error.message);
      continue; // Skip to the next repository on error
    }
  }
  repoCsvStream.end();
  contributorCsvStream.end();
  console.log('Data saved to github_repos.csv and github_contributors.csv');
}

main().catch(console.error);