var express = require('express');
var router = express.Router();
var request = require('request');
var async = require('async');
var adapi = require('../middleware/adapi');
var auth = require('../middleware/auth');
var connection = require('../middleware/mysql');
var encryption = require('../middleware/encryption');
var db_tools = require('../tools/db_tools');

var test_switch = {
  auth: function(req, res, next){
    return next();
  }
};
//This lets us overwrite in test to load in res.locals
router.use(function(req,res,next){
  return test_switch.auth(req, res, next);
});

function add_user(body, callback){
  if(!body || !body.Username || !body.FirstName || !body.LastName || !body.Email){
    return callback("No User info");
  }
  var user = {
    Username: body.Username,
    FirstName: body.FirstName,
    LastName: body.LastName,
    Email: body.Email,
    IsSVC: false
  };
  //@TODO: call out to password portal
  var query = 'Update `users` set `Active`=1 where `Username` = ?';
  connection.query(query, [body.Username], function(err, result){
    if(err){
      console.log(err);
      return callback(err);
    }
    body.Active=1;
    return callback(null, body);
  });
}

function update_user(body, caller, callback){
  var User_ID = body.ID;
  // get User info to update databases
  connection.query('Select * from users where ID = ?', [User_ID], function(err, userinfo){
    if(err){
      return callback(err);
    }
    if(userinfo.length<1){
      return callback('No User with that ID!');
    }
    var user = userinfo[0];
    //get old user_groups
    connection.query('Select Group_ID as ID, Permissions, GroupAdmin from users_groups where User_ID = ?', [User_ID], function(err, results){
      if(err){
        return callback(err);
      }
      var adds = [];
      var dels = [];
      var groups = body.Groups || [];
      groups.forEach(function(g){
        var found=false;
        for(var i =0; i<results.length; i++){
          var r = results[i];
          if(r.ID === g.ID){
            found = true;
            if(r.Permissions !== g.Permissions || r.GroupAdmin!==g.GroupAdmin){
              adds.push(g);
            }
            break;
          }
        }
        if(!found){
          adds.push(g);
        }
      });
      results.forEach(function(r){
        var found=false;
        for(var i =0; i<groups.length; i++){
          var g = groups[i];
          if(g.ID === r.ID){
              found = true;
              break;
          }
        }
        if(!found){
          dels.push(r);
        }
      });
      var totChange = adds.concat(dels);
      if(totChange.length===0){
        return callback(null, body);
      }
      //full admins can do what they want
      if(caller.Admins.indexOf(-1)<0){
        //group admins can only edit their own group
        for(var i=0; i<totChange.length; i++){
          var gchange = totChange[i];
          if(caller.Admins.indexOf(gchange.ID)<0){
            return callback('Not Authorized to make this change');
          }
        }
      }
      var binstert = adds.map(x => [User_ID, x.ID, x.Permissions, x.GroupAdmin]);
      var q = 'Set @dummy=1;';
      if(binstert.length >0){
        q = 'Insert into `users_groups` (`User_ID`, `Group_ID`, `Permissions`, `GroupAdmin`) VALUES ' + connection.escape(binstert) + ' ON DUPLICATE KEY UPDATE `Permissions`=VALUES(`Permissions`), `GroupAdmin`=VALUES(`GroupAdmin`)';
      }
      // add/update groups that are still gospel
      connection.query(q, function(err, result){
        if(err){
          return callback(err);
        }
        var delIDs = dels.map(x => x.ID);
        var delq = 'Set @dummy=1';
        if(delIDs.length > 0){
          delq = 'Delete from users_groups where Group_ID in (' + connection.escape(delIDs)+');';
        }
        // delete groups no longer allowed
        connection.query(delq, function(err, result){
          if(err){
            return callback(err);
          }
          var changedIDs = totChange.map(x => x.ID);
          if(changedIDs.length <1){
            return callback(null, body);
          }
          else{
            var dbq = 'Select Distinct * from `databases` where ID in (Select Database_ID from groups_databases where Group_ID in (' + connection.escape(changedIDs)+'));';
            connection.query(dbq, function(err, dbs){
              if(err){
                return callback(err);
              }
              async.each(dbs,function(db, inner_callback){
                db_tools.update_users(db, [user], function(errs){
                  inner_callback();
                });
              }, function(err, result){
                console.log("All Databases Updated for " + body.Username);
              });
              return callback(null, body);
            });
          }
        });
      });
    });
  });
}

router.get('/:groupid', function(req, res){
  var groupid = req.params.groupid;
  connection.query('Select users.Username, users_groups.Permissions, users_groups.GroupAdmin from users Join users_groups on users_groups.User_ID = users.ID where users_groups.Group_ID= ? Order by GroupAdmin DESC, (users_groups.Permissions+0) ASC;', [groupid], function(err, results){
    if(err){
      console.log(err);
      return res.send({Success: false, Error: err});
    }
    return res.send({Success: true, Results: results});
  });
});

router.post('/search/:page', function(req, res){
  var body = req.body;
  var page = req.params.page;
  var start=  page * 50;
  var args = [];
  var count_query = 'Select Count(*) as Total from users';
  var query = 'Select ID, Username, Email, FirstName, LastName, LENGTH(MySQL_Password) as hasmysql, LENGTH(SQL_Server_Password) as hasmssql, Active from users';
  if(body.Info && body.Info.trim().length > 0){
    var info = "%"+body.Info+"%";
    args = [info, info, info, info];
    count_query += ' where (Username like ? OR Email like ? OR FirstName like ? OR LastName like ?)';
    query += ' where (Username like ? OR Email like ? OR FirstName like ? OR LastName like ?)';
  }
  connection.query(count_query +';', args, function(err, results){
    if(err){
      console.log(err);
      return res.send({Success: false, Error: err});
    }
    var total = results[0].Total;
    args.push(start);
    connection.query(query + ' ORDER BY Active DESC, Username ASC LIMIT ?,50;', args, function(err, users){
      if(err){
        console.log(err);
        return res.send({Success: false, Error: err});
      }
      return res.send({Success: true,  Results: users, Total: total});
    });
  });
});

router.post('/', function(req, res){
  var body = req.body;
  var exists = !!body.Active;
  async.waterfall([
    function(callback){
      if(body.Active && body.Active == 1){
        return callback(null, body);
      }
      add_user(body, callback);
    },
    function(arg1, callback){
      update_user(arg1, res.locals.user, callback);
    },
    function(userinfo, callback){
      var activity = "";
      if(exists){
        activity = '"Updated user: ?"';
      }
      else{
        activity = '"Added user: ?"';
      }
      connection.query('Insert into History (Activity) Value('+ activity +')', [userinfo.Username], function(err, result){
        if(err){
          console.log(err);
        }
        return callback(null, userinfo.Active);
      });
    }
  ], function(err, result){
    if(err){
      console.log(err);
      return res.send({Success:false, Error: err});
    }
    return res.send({Success:true, Active: result});
  });
});

router.use(function(req, res, next){
  return auth.isAdmin(req, res, next);
});

router.post('/passwordchange', function(req, res){
  var passwords = req.body.Passwords;
  async.each(Object.keys(passwords), function(p, cb){
    encryption.encrypt(passwords[p], function(err, enc){
      if(err){
        return cb(err);
      }
      else{
        passwords[p] = enc;
        return cb();
      }
    });
  }, function(err){
    if(err){
      console.log(err);
      return res.send({Success:false, Error:err});
    }
    connection.query('Select * from users where Username = ?;', [req.body.Username], function(err, users){
      if(err){
        console.log(err);
        return res.send({Success: false, Error:err});
      }
      if(users.length<1){
        return res.send({Success: false, Error: 'No user by that username'});
      }
      var user = users[0];
      connection.query('Update `users` set `MySQL_Password`=?, `SQL_Server_Password`=? Where `ID`=?;', [passwords.mysql, passwords.mssql, user.ID], function(err, result){
        if(err){
          console.log(err);
          return res.send({Success: false, Error:err});
        }
        var dbq = 'Select `databases`.* from `databases` join `groups_databases` on `groups_databases`.`Database_ID` = `databases`.`ID` join `users_groups` on `users_groups`.`Group_ID`=`groups_databases`.`Group_ID` join `users` on `users`.`ID` = `users_groups`.`User_ID` where `Users`.`Username`=?;';
        connection.query(dbq, [req.body.Username], function(err, results){
          if(err){
            console.log(err);
            return res.send({Success: false, Error:err});
          }
          if(results.length<1){
            return res.send({Success: true});
          }
          async.each(results,function(db, inner_callback){
            db_tools.update_users(db, [user], function(errs){
              inner_callback();
            });
          }, function(err, result){
            console.log("All Databases Updated for " + req.body.Username);
          });
          return res.send({Success: true});
        });
      });
    });
  });
});

router.delete('/:id', function(req,res){
  var user_id = req.params.id;
  connection.query("Select * from users where ID = ?", [user_id], function(err, results){
    if(err){
      console.log(err);
      return res.send({Success: false, Error: err});
    }
    if(results.length<1){
      return res.send({Success: false, Error: 'No such user!'});
    }
    var user = results[0];
    var username = user.Username;
    //@TODO: add call to password manager
    var db_query = "Select DISTINCT * from `databases` where ID in (Select Database_ID from groups_databases where Group_ID in (Select Group_ID from users_groups where User_ID = ?))";
    connection.query(db_query, [user_id], function(err, results){
      if(err){
        console.log(err);
        return res.send({Success:false, Error: err});
      }
      var affected_dbs = results;
      var query = "Delete from Users_Groups where User_ID = ?";
      connection.query(query, [user_id], function(err, result){
        if(err){
          console.log(err);
          return res.send({Success:false, Error: err});
        }
        async.each(affected_dbs, function(db, cb){
          db_tools.update_users(db, [user], function(errs){
            cb();
          });
        }, function(err){
          console.log("All Databases Updated to remove " + username);
          connection.query('Update Users set Active = 0 where ID = ?;', [user_id], function(err, result){
            if(err){
              console.log(err);
              return res.send({Success:false, Error: err});
            }
            connection.query('Insert into History (Activity) Value("Deleted user: ?")', [username], function(err, result){
              if(err){
                console.log(err);
                return res.send({Success: true, Error: "History error: " + err.toString(), });
              }
              return res.send({Success: true});
            });
          });
        });
      });
    });
  });
});

module.exports = router;
