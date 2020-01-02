#!/usr/bin/env node
var HabitAPI = require('./HabitAPI');
var request = require('superagent');
var async = require('async');
var fs = require('fs');
var _ = require('lodash');
var util = require('util');

var history = {};

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
  }

  run(done) {
    history = this.readHistoryFromFile(this.historyPath);
    if (!history.tasks) {
      history.tasks = {};
    }
    var oldHistory = _.cloneDeep(history);
    async.waterfall(
      [
        cb => {
          this.getHabitAttributeIds(cb);
        },
        (attributes, cb) => {
          this.habitAttributes = attributes;
          this.getTodoistSync(cb);
        },
        (res, cb) => {
          history.sync_token = res.body.sync_token;
          this.updateHistoryForTodoistItems(res.body.items);
          var changedTasks = this.findTasksThatNeedUpdating(history, oldHistory);
          this.syncItemsToHabitRpg(changedTasks, cb);
        },
      ],
      (err, newHistory) => {
        if (err) {
          return done(err);
        }
        fs.writeFileSync(this.historyPath, JSON.stringify(newHistory));
        done();
      },
    );
  }

  findTasksThatNeedUpdating(newHistory, oldHistory) {
    var needToUpdate = [];
    _.forEach(newHistory.tasks, item => {
      var old = oldHistory.tasks[item.todoist.id];
      var updateLabels = false;
      if (old) {
        updateLabels = this.checkTodoistLabels(old.todoist.labels, item.todoist.labels);
      }
      if (
        !old ||
        !old.todoist ||
        old.todoist.content != item.todoist.content ||
        old.todoist.checked != item.todoist.checked ||
        old.todoist.due_date_utc != item.todoist.due_date_utc ||
        old.todoist.is_deleted != item.todoist.is_deleted ||
        updateLabels
      ) {
        needToUpdate.push(item);
      }
    });
    return needToUpdate;
  }

  updateHistoryForTodoistItems(items) {
    var habit = new HabitAPI(this.uid, this.token, null, 'v2');
    _.forEach(items, function(item) {
      if (history.tasks[item.id]) {
        if (item.is_deleted) {
          // TODO: Determine if you want to delete the task in the habit sync function
          var habitId = history.tasks[item.id].habitrpg.id;
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
    var history = {};
    if (fs.existsSync(path)) {
      var data = fs.readFileSync(path, 'utf8');
      history = JSON.parse(data);
    }
    return history;
  }

  getTodoistSync(cb) {
    var sync_token = history.sync_token || '*';
    request
      .get(
        `https://api.todoist.com/sync/v8/sync?token=${this.todoist}&sync_token=${sync_token}&resource_types=["all"]`,
      )
      .end(function(err, res) {
        cb(err, res);
      });
  }

  syncItemsToHabitRpg(items, cb) {
    var habit = new HabitAPI(this.uid, this.token);
    // Cannot execute in parallel. See: https://github.com/HabitRPG/habitrpg/issues/2301
    async.eachSeries(
      items,
      (item, next) => {
        async.waterfall(
          [
            cb => {
              var dueDate, attribute;
              if (item.todoist.due_date_utc) {
                dueDate = new Date(item.todoist.due_date_utc);
              }
              var taskType = this.parseTodoistRepeatingDate(item.todoist);
              var repeat = taskType.repeat;
              var task = {
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
              if (item.habitrpg && item.habitrpg.id) {
                if (task.type == 'todo') {
                  // Checks if the complete status has changed
                  if (
                    (task.completed != item.habitrpg.completed &&
                      item.habitrpg.completed !== undefined) ||
                    (task.completed === true && item.habitrpg.completed === undefined)
                  ) {
                    var direction = task.completed === true;
                    console.log(`updating completion (${direction}): ${task.text}`);
                    habit.updateTaskScore(item.habitrpg.id, direction, _.noop);
                    // Need to set dateCompleted on todo's that are checked
                    if (direction) {
                      task.dateCompleted = new Date();
                    } else if (!direction) {
                      task.dateCompleted = '';
                    }
                  }
                } else if (task.type == 'daily') {
                  var oldDate = new Date(item.habitrpg.date);
                  // Checks if the due date has changed, indicating that it was clicked in Todoist
                  if (task.date > oldDate) {
                    var direction = true;
                    task.completed = true;
                    habit.updateTaskScore(item.habitrpg.id, direction, function(
                      response,
                      error,
                    ) {});
                  } else if (item.habitrpg.completed) {
                    task.completed = true;
                  }
                }
                console.log(`updating task: ${task.text}`);
                habit.updateTask(item.habitrpg.id, task, function(err, res) {
                  cb(err, res);
                });
              } else {
                if (task.type == 'todo' && task.completed) {
                  task.dateCompleted = new Date();
                }
                console.log(`creating task: ${task.text}`);
                habit.createTask(task, function(err, res) {
                  cb(err, res);
                });
              }
            },
            (res, cb) => {
              history.tasks[item.todoist.id] = {
                todoist: item.todoist,
                habitrpg: res.body.data,
              };
              // Adds date to habitrpg record if type is daily
              if (res.body && res.body.type == 'daily') {
                var date = item.todoist.due.datetime || item.todoist.due.date;
                history.tasks[item.todoist.id].habitrpg.date = new Date(date);
              } else if (!res.body) {
                // TODO: Remove this once GH issue #44 actually gets fixed.
                console.error(
                  'ERROR: Body is undefined. Please file an issue with this. res:' +
                    util.inspect(res),
                );
              }
              cb();
            },
          ],
          next,
        );
      },
      err => {
        cb(err, history);
      },
    );
  }

  getHabitAttributeIds(callback) {
    // Gets a list of label ids and puts
    // them in an object if they correspond
    // to HabitRPG attributes (str, int, etc)
    var labels = {};
    request
      .post('https://api.todoist.com/rest/v1/labels')
      .set('Authorization', `Bearer ${this.todoist}`)
      .end((err, res) => {
        var labelObject = res.body;
        for (var l in labelObject) {
          labels[l] = labelObject[l].id;
        }
        var attributes = { str: [], int: [], con: [], per: [] };
        for (var l in labels) {
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
        callback(null, attributes);
      });
  }

  checkForAttributes(labels) {
    // Cycle through todoist.labels
    // For each label id, check it against the ids stored in habitAttributes
    // If a match is found, return it
    for (var label in labels) {
      for (var att in this.habitAttributes) {
        for (var num in this.habitAttributes[att]) {
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
    for (var i in oldLabel) {
      if (oldLabel[i] != newLabel[i]) {
        return true;
      }
    }
    return false;
  }

  parseTodoistRepeatingDate(todoist) {
    var type = 'todo';
    var repeat = todoist.due && todoist.due.recurring;
    if (!repeat) return { type, repeat };

    var dateString = todoist.due.string;
    var noStartDate = !dateString.match(
      /(after|starting|last|\d+(st|nd|rd|th)|(first|second|third))/i,
    );
    var needToParse = dateString.match(/^ev(ery)? [^\d]/i) || dateString === 'daily';
    if (needToParse && noStartDate) {
      type = 'daily';
      var everyday =
        !!dateString.match(/^ev(ery)? [^(week)]?(?:day|night)/i) || dateString === 'daily';
      var weekday = !!dateString.match(/^ev(ery)? (week)?day/i);
      var weekend = !!dateString.match(/^ev(ery)? (week)?end/i);
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
}

module.exports = HabitSync;
