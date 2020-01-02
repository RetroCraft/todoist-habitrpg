var request = require('superagent');
var _ = require('lodash');

var routes = {
  groups: '/groups',
  users: '/user',
  tags: '/tags',
  tasks: '/tasks',
};

class HabitAPI {
  constructor(userId, apiKey, apiUrl, apiVer) {
    this.userId = userId;
    this.apiKey = apiKey;
    this.apiUrl = apiUrl || 'https://habitica.com/api/v3';
    this.apiVersion = !apiVer ? 'v3' : apiVer;
  }

  buildRequest(method, endpoint, sendObj, onlyRoot) {
    var url;
    if (onlyRoot) {
      // onlyRoot specifies if we should remove the /api portion and only use the url Root.
      url = this.apiUrl;
      var urlIndex = url.indexOf('/api/');
      url = url.substring(0, urlIndex);
    } else {
      url = this.apiUrl;
    }
    url = url + endpoint;
    var req = request;
    if (method === 'GET') {
      req = req.get(url);
    }
    if (method === 'POST') {
      if (sendObj) {
        req = req.post(url).send(sendObj);
      } else {
        req = req.post(url);
      }
    }
    if (method === 'PUT') {
      req = req.put(url).send(sendObj);
    }
    if (method === 'DEL') {
      req = req.del(url);
    }
    req = req
      .set('x-api-user', this.userId)
      .set('x-api-key', this.apiKey)
      .set('Accept', 'application/json');
    // Hack to get v2 apps to work with the v3 api with minimal changes
    req.oldEnd = req.end;
    req.end = cb => {
      req.oldEnd((err, res) => {
        this.formatResponse(err, res, cb);
      });
    };
    return req;
  }

  getStatus(cb) {
    var req = this.buildRequest('GET', '/status');
    req.end(cb);
  }

  getContent(cb) {
    var req = this.buildRequest('GET', '/content');
    req.end(cb);
  }

  getHistory(cb) {
    var req = this.buildRequest('GET', '/export/history.csv', null, true);
    req.end(cb);
  }

  createTask(task, cb) {
    var req = this.buildRequest('POST', routes.tasks + '/user', task);
    req.end(cb);
  }

  getTask(id, cb) {
    var req = this.buildRequest('GET', routes.tasks + '/' + id);
    req.end(cb);
  }

  getTasks(cb) {
    var req = this.buildRequest('GET', routes.tasks + '/user');
    req.end(cb);
  }

  updateTask(id, task, cb) {
    var req = this.buildRequest('PUT', routes.tasks + '/' + id, task);
    req.end(cb);
  }

  deleteTask(id, cb) {
    var req = this.buildRequest('DEL', routes.tasks + '/' + id);
    req.end(cb);
  }

  updateTaskScore(id, direction, cb) {
    if (direction === true) {
      direction = 'up';
    } else if (direction === false) {
      direction = 'down';
    }
    var req = this.buildRequest('POST', routes.tasks + '/' + id + '/score/' + direction);
    req.end(cb);
  }

  getUser(cb) {
    var req = this.buildRequest('GET', routes.users);
    req.end(cb);
  }

  createTag(tag, cb) {
    var req = this.buildRequest('POST', routes.tags, tag);
    req.end(function(err, res) {
      if (this.apiVersion === 'v2') {
        res.body = [res.body];
      }
      cb(err, res);
    });
  }

  updateTag(id, tag, cb) {
    var req = this.buildRequest('PUT', routes.tags + '/' + id, tag);
    req.end(cb);
  }

  deleteTag(id, cb) {
    var req = this.buildRequest('DEL', routes.tags + '/' + id);
    req.end(cb);
  }

  getTagByName(name, cb) {
    this.getUser(function(error, res) {
      if (error) {
        return cb(error, null);
      }
      var tags = res.body.tags;
      var tagFound = _.find(tags, function(tag) {
        return tag.name == name;
      });
      if (!tagFound) {
        tagFound = {};
      }
      res.body = tagFound;
      cb(error, res);
    });
  }

  getTag(id, cb) {
    var req = this.buildRequest('GET', routes.tags + '/' + id);
    req.end(cb);
  }

  getTags(cb) {
    var req = this.buildRequest('GET', routes.tags);
    req.end(cb);
  }

  getGroups(cb) {
    var req = this.buildRequest(
      'GET',
      routes.groups + '?type=party,guilds,privateGuilds,publicGuilds,tavern',
    );
    req.end(cb);
  }

  getGroupsByType(types, cb) {
    var req = this.buildRequest('GET', routes.groups + '?type=' + types);
    req.end(cb);
  }

  getGroup(gid, cb) {
    var req = this.buildRequest('GET', routes.groups + '/' + gid);
    req.end(cb);
  }

  // formatResponse allows compatability with the v2 api
  formatResponse(err, res, cb) {
    if (this.apiVersion === 'v2' && res.body) {
      res.body = res.body.data;
    }
    cb(err, res);
  }
}

module.exports = HabitAPI;
