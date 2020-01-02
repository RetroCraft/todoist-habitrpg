#!/usr/bin/env node
const axios = require('axios').default;
const fs = require('fs');
const _ = require('lodash');
const util = require('util');

const HabitAPI = require('./HabitAPI');
let habit;
let history = {};

//
// options.uid: HabitRPG UserId
// options.token: HabitRPG API Token
// options.todoist: Todoist API Token
// options.historyPath: Directory for history
//
class HabitSync {
  constructor(options) {
    if (!options) {
      throw new Error('Options are required');
    }
    if (!options.uid) {
      throw new Error('No HabitRPG User Id found');
    }
    if (!options.token) {
      throw new Error('No HabitRPG API Token found');
    }
    if (!options.todoist) {
      throw new Error('No Todoist API Token found');
    }
    if (options.historyPath) {
      this.historyPath = options.historyPath + '/.todoist-habitrpg.json';
    } else {
      // Defaults
      if (process.platform == 'win32') {
        this.historyPath = process.env.HOMEPATH + '/.todoist-habitrpg.json';
      } else {
        this.historyPath = process.env.HOME + '/.todoist-habitrpg.json';
      }
    }
    this.uid = options.uid;
    this.token = options.token;
    this.todoist = options.todoist;

    habit = new HabitAPI(this.uid, this.token, null, 'v2');
  }

  async run() {
    history = this.readHistoryFromFile(this.historyPath);
    if (!history.tasks) {
      history.tasks = {};
    }
    const oldHistory = _.cloneDeep(history);
    console.log(`read ${Object.keys(oldHistory.tasks).length} tasks from history`);
    this.habitAttributes = await this.getHabitAttributeIds();
    const res = await this.getTodoistSync();
    history.sync_token = res.data.sync_token;
    this.updateHistoryForTodoistItems(res.data.items);
    const changedTasks = this.findTasksThatNeedUpdating(history, oldHistory);
    console.log(`creating/updating ${changedTasks.length} tasks`);
    const newHistory = await this.syncItemsToHabitRpg(changedTasks);
    fs.writeFileSync(this.historyPath, JSON.stringify(newHistory));
  }

  findTasksThatNeedUpdating(newHistory, oldHistory) {
    const needToUpdate = [];
    _.forEach(newHistory.tasks, item => {
      const old = oldHistory.tasks[item.todoist.id];
      const updateLabels = old
        ? this.checkTodoistLabels(old.todoist.labels, item.todoist.labels)
        : false;
      if (
        !old ||
        !old.todoist ||
        old.todoist.content != item.todoist.content ||
        old.todoist.checked != item.todoist.checked ||
        !_.isEqual(old.todoist.due, item.todoist.due) ||
        old.todoist.is_deleted != item.todoist.is_deleted ||
        updateLabels
      ) {
        needToUpdate.push(item);
      }
    });
    return needToUpdate;
  }

  updateHistoryForTodoistItems(items) {
    _.forEach(items, function(item) {
      if (history.tasks[item.id]) {
        if (item.is_deleted) {
          // TODO: Determine if you want to delete the task in the habit sync function
          const habitId = history.tasks[item.id].habitrpg.id;
          habit.deleteTask(habitId, function(response, error) {});
          // Deletes record from sync history
          delete history.tasks[item.id];
        } else {
          history.tasks[item.id].todoist = item;
        }
      } else if (!item.is_deleted) {
        // Only adds item to history if it was not deleted before syncing to habitrpg
        history.tasks[item.id] = { todoist: item };
      }
    });
  }

  readHistoryFromFile(path) {
    let history = {};
    if (fs.existsSync(path)) {
      const data = fs.readFileSync(path, 'utf8');
      history = JSON.parse(data);
    }
    return history;
  }

  getTodoistSync() {
    const sync_token = history.sync_token || '*';
    return axios.get('https://api.todoist.com/sync/v8/sync', {
      params: {
        token: this.todoist,
        sync_token,
        resource_types: '["all"]',
      },
    });
  }

  async syncItemsToHabitRpg(items) {
    await Promise.all(
      items.map(async item => {
        const res = await this.syncItemToHabitRpg(item);
        history.tasks[item.todoist.id] = {
          todoist: item.todoist,
          habitrpg: res.body,
        };
        // Adds date to habitrpg record if type is daily
        if (res.body && res.body.type == 'daily') {
          history.tasks[item.todoist.id].habitrpg.date = this.parseDate(item.todoist.due.date);
          return history;
        } else if (!res.body) {
          // TODO: Remove this once GH issue #44 actually gets fixed.
          throw new Error('Body is undefined. ' + util.inspect(res));
        }
      }),
    );

    return history;
  }

  async syncItemToHabitRpg(item) {
    let dueDate, attribute;
    if (item.todoist.due) {
      dueDate = this.parseDate(item.todoist.due.date);
    }
    const taskType = this.parseTodoistRepeatingDate(item.todoist);
    const task = {
      text: item.todoist.content,
      dateCreated: new Date(item.todoist.date_added),
      date: dueDate,
      type: taskType.type,
      repeat: taskType.repeat,
      completed: item.todoist.checked == true,
      priority: [0, 0.1, 1, 1.5, 2][item.todoist.priority],
    };
    if (item.todoist.labels.length > 0) {
      attribute = this.checkForAttributes(item.todoist.labels);
    }
    if (attribute) {
      task.attribute = attribute;
    }

    let res;
    if (item.habitrpg && item.habitrpg.id) {
      if (task.type == 'todo') {
        // Checks if the complete status has changed
        if (
          (task.completed != item.habitrpg.completed && item.habitrpg.completed !== undefined) ||
          (task.completed === true && item.habitrpg.completed === undefined)
        ) {
          const direction = task.completed === true;
          console.log(`updating completion of ${task.type} (${direction}): ${task.text}`);
          await new Promise((resolve, reject) => {
            habit.updateTaskScore(item.habitrpg.id, direction, (err, res) =>
              err ? reject(err) : resolve(res),
            );
          });
          // Need to set dateCompleted on todo's that are checked
          if (direction) {
            task.dateCompleted = new Date();
          } else if (!direction) {
            task.dateCompleted = '';
          }
        }
      } else if (task.type == 'daily') {
        const oldDate = new Date(item.habitrpg.date);
        // Checks if the due date has changed, indicating that it was clicked in Todoist
        if (task.date > oldDate) {
          const direction = true;
          task.completed = true;
          habit.updateTaskScore(item.habitrpg.id, direction, (res, err) => err && reject(err));
        } else if (item.habitrpg.completed) {
          task.completed = true;
        }
      }
      console.log(`updating ${task.type}: ${task.text}`);
      res = await new Promise((resolve, reject) =>
        habit.updateTask(item.habitrpg.id, task, (err, res) => (err ? reject(err) : resolve(res))),
      );
    } else {
      if (task.type == 'todo' && task.completed) {
        task.dateCompleted = new Date();
      }
      console.log(`creating ${task.type}: ${task.text}`);
      res = await new Promise((resolve, reject) =>
        habit.createTask(task, (err, res) => (err ? reject(err) : resolve(res))),
      );
    }

    return res;
  }

  async getHabitAttributeIds() {
    // Gets a list of label ids and puts
    // them in an object if they correspond
    // to HabitRPG attributes (str, int, etc)
    const labels = {};
    const res = await axios.get('https://api.todoist.com/rest/v1/labels', {
      headers: { Authorization: `Bearer ${this.todoist}` },
    });
    const labelObject = res.body;
    for (const l in labelObject) {
      labels[l] = labelObject[l].id;
    }
    const attributes = { str: [], int: [], con: [], per: [] };
    for (let l in labels) {
      if (l == 'str' || l == 'strength' || l == 'physical' || l == 'phy') {
        attributes.str.push(labels[l]);
      } else if (l == 'int' || l == 'intelligence' || l == 'mental' || l == 'men') {
        attributes.int.push(labels[l]);
      } else if (l == 'con' || l == 'constitution' || l == 'social' || l == 'soc') {
        attributes.con.push(labels[l]);
      } else if (l == 'per' || l == 'perception' || l == 'other' || l == 'oth') {
        attributes.per.push(labels[l]);
      }
    }
    return attributes;
  }

  checkForAttributes(labels) {
    // Cycle through todoist.labels
    // For each label id, check it against the ids stored in habitAttributes
    // If a match is found, return it
    for (const label in labels) {
      for (const att in this.habitAttributes) {
        for (const num in this.habitAttributes[att]) {
          if (this.habitAttributes[att][num] == labels[label]) {
            return att;
          }
        }
      }
    }
  }

  checkTodoistLabels(oldLabel, newLabel) {
    // Compares ids of todoist.labels to determine
    // if the item needs updating
    if (oldLabel.length != newLabel.length) {
      return true;
    }
    for (const i in oldLabel) {
      if (oldLabel[i] != newLabel[i]) {
        return true;
      }
    }
    return false;
  }

  parseTodoistRepeatingDate(todoist) {
    let type = 'todo';
    let repeat = todoist.due && todoist.due.is_recurring;
    if (!repeat) return { type, repeat };

    const dateString = todoist.due.string;
    const noStartDate = !dateString.match(
      /(after|starting|last|\d+(st|nd|rd|th)|(first|second|third))/i,
    );
    const needToParse = dateString.match(/^ev(ery)? [^\d]/i) || dateString === 'daily';
    if (needToParse && noStartDate) {
      type = 'daily';
      const everyday =
        !!dateString.match(/^ev(ery)? [^(week)]?(?:day|night)/i) || dateString === 'daily';
      const weekday = !!dateString.match(/^ev(ery)? (week)?day/i);
      const weekend = !!dateString.match(/^ev(ery)? (week)?end/i);
      repeat = {
        su: everyday || weekend || !!dateString.match(/\bs($| |,|u)/i),
        s: everyday || weekend || !!dateString.match(/\bsa($| |,|t)/i),
        f: everyday || weekday || !!dateString.match(/\bf($| |,|r)/i),
        th: everyday || weekday || !!dateString.match(/\bth($| |,|u)/i),
        w: everyday || weekday || (!!dateString.match(/\bw($| |,|e)/i) && !weekend),
        t: everyday || weekday || !!dateString.match(/\bt($| |,|u)/i),
        m: everyday || weekday || !!dateString.match(/\bm($| |,|o)/i),
      };
    }
    return { type, repeat };
  }

  parseDate(string) {
    if (string.endsWith('Z')) return new Date(string);
    return new Date(string + '-05:00');
  }
}

module.exports = HabitSync;
