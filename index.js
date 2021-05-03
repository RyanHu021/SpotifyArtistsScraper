// imports
const Discord = require('discord.js');
const webdriver = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const http = require('follow-redirects').http;
const config = require('./config.json');

// client and config
const client = new Discord.Client();
const serverID = config.serverID;
const logChannelID = config.logChannelID;

// chrome driver options
let driver;
let serviceBuilder = new chrome.ServiceBuilder(process.env.CHROMEDRIVER_PATH);
let options = new chrome.Options();
options.setChromeBinaryPath(process.env.GOOGLE_CHROME_BIN);
options.addArguments("--headless");
options.addArguments("--disable-gpu");
options.addArguments("--no-sandbox");

// http options
let httpOptions = {
    host: 'artistinsights-downloads.spotify.com',
    path: `/v1/artist/${config.artistID}/downloads/timelines.csv`,
    headers: {
        'Cookie': ''
    }
};

// date and song array
let dates = [];
let songs = [];

client.once('ready', async () => {
    await refreshTimeline();
    log('Ready: ' + new Date());
});

client.on('message', message => {
    if (!message.content.startsWith(config.prefix) || message.author.bot) return;

    const args = message.content.slice(config.prefix.length).trim().toLowerCase().split(/ +/);
    const command = args.shift().toLowerCase();

    // format: !streams song_name date date
    if (command === 'streams' && args.length >= 2 && args.length <= 3) {
        let songData = null;;
        for (let song of songs) {
            if (song.name.toLowerCase() === args[0].toLowerCase().replace(/-/g, ' ')) {
                songData = song;
            }
        }

        if (songData != null) {
            var startDate;
            var endDate;
            if (!isNaN(Date.parse(args[1]))) {
                startDate = new Date(args[1]);
            } else {
                return;
            }
            if (args.length === 3 && !isNaN(Date.parse(args[2]))) {
                endDate = new Date(args[2]);
            } else {
                endDate = startDate;
            }
            
            let total = 0;
            for (let d of songData.dates) {
                if (d.date.getTime() >= startDate.getTime() && d.date.getTime() <= endDate.getTime()) {
                    total += d.streams;
                }
            }
            message.channel.send(`${songData.name} - ${startDate.toString().substring(0, 15)} - ${endDate.toString().substring(0, 15)}: ${total} streams`);
        }
    } else if (command === 'refresh') {
        dates = [];
        songs = [];
        refreshTimeline();
    }
});

async function refreshTimeline() {
    log('Refreshing timeline and songs...');

    // initialize the chrome driver
    driver = new webdriver.Builder().forBrowser('chrome').setChromeService(serviceBuilder).setChromeOptions(options).build();

    // login
    driver.get(`https://accounts.spotify.com/en/login?continue=https:%2F%2Fartists.spotify.com%2Fc%2Fartist%2F${config.artistID}%2Faudience`);
    driver.findElement(webdriver.By.id('login-username')).sendKeys(config.username);
    driver.findElement(webdriver.By.id('login-password')).sendKeys(config.password);
    driver.findElement(webdriver.By.id('login-button')).click();

    // wait for page to load
    await driver.wait(webdriver.until.elementLocated(webdriver.By.id('timeline')), 20000);
    log('Logged into Spotify for Artists');

    // get cookies
    driver.manage().getCookies().then(cookies => {
        let cookieStr = '';
        for (let cookie of cookies) {
            cookieStr += `${cookie.name}=${cookie.value}; `;
        }

        // add cookies to http request header
        httpOptions.headers.Cookie = cookieStr.substring(0, cookieStr.length - 2);
    });

    // perform http request
    log('Getting timeline...');
    const req = http.request(httpOptions, response => {
        log('Received HTTP Response ' + response.statusCode);
        let str = '';

        // get data from the CSV file
        response.on('data', chunk => {
            str += chunk;
        });

        // convert data to date array
        response.on('end', () => {
            dates = [];
            // split CSV file into lines
            for (let line of str.split('\n')) {
                // exclude empty dates and CSV header
                if (!line.endsWith('0,0,0') && !line.startsWith('date')) {
                    // split each line into date, listeners, streams, and followers
                    let tokens = line.split(',');
                    dates.push(createNewDate(new Date(tokens[0]), parseInt(tokens[1]), parseInt(tokens[2]), parseInt(tokens[3])));
                }
            }
            dates.reverse();
            log(`Timeline (${dates.length} dates) refreshed: ${new Date()}`);
        });
    });

    req.on('error', error => {
        log(error.toString());
        log('Timeline failed to refresh');
    });
    req.end();    

    for (let name of config.songs) {
        await refreshSongTimeline(name).then(song => {
            songs.push(song);
        });
    }

    /*for (let song of songs) {
        console.log(song.name);
        for (let obj of song.dates) {
            console.log(obj.date, obj.streams);
        }
        console.log ('--------------');
    }*/

    driver.quit();
    log('Done refreshing');
}

async function refreshSongTimeline(id) {
    log(`Getting streams for song ${id}...`);
    let song = {};
    song.name = '';
    song.dates = [];

    // load song page
    driver.get(`https://artists.spotify.com/c/artist/${config.artistID}/song/${id}/stats?time-filter=1year`);
    await driver.wait(webdriver.until.elementLocated(webdriver.By.id('timeline')), 20000);

    // get the title
    driver.findElement(webdriver.By.className('cDROwI')).getText().then(name => {
        song.name = name.replace(/- /g, '');
    });

    // loop through each element of the graph
    await driver.findElements(webdriver.By.className('BNtsP')).then(async (elements) => {
        for (let element of elements) {
            let data;

            // get the value of the aria-label element, which contains the date and stream count (e.g. 'January 1 2021, 500')
            await element.getAttribute('aria-label').then(value => {
                data = value;
            });

            // exclude empty dates and extra elements
            if (!data.endsWith(', 0') && !data.endsWith('streams')) {
                let token = data.split(', ');
                let obj = {};
                obj.date = new Date(token[0]);
                if (token[1].endsWith('k')) {
                    token[1] = token[1].substring(0, token[1].length - 1);
                    obj.streams = parseInt(parseFloat(token[1]) * 1000);
                } else {
                    obj.streams = parseInt(token[1]);
                }
                song.dates.push(obj);
            }
        }
    });

    return song;
}

function createNewDate(date, listeners, streams, followers) {
    let obj = {};
    obj.date = date;
    obj.listeners = listeners;
    obj.streams = streams;
    obj.followers = followers;
    return obj;
}

function log(message) {
    console.log(message);
    client.guilds.cache.get(serverID).channels.cache.get(logChannelID).send(message);
}

client.login(config.token);
