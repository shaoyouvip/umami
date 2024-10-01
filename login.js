var request = require('request');
var url="http://<your.umami.website>/api/auth/login";
var requestData={
    "username": "admin",
    "password": "xxxxxxxx"
};

httprequest(url,requestData);

function httprequest(url,data){
    console.log("hello world")
    request({
        url: url,
        method: "POST",
        json: true,
        headers: {
            "content-type": "application/json",
        },
        body: requestData
    }, function(error, response, body) {
        if (!error && response.statusCode == 200) {
            console.log(body) // 请求成功的处理逻辑
        }else{
            console.log("failed")
            console.log(response.statusCode)
            console.log(error)
        }
    });
};
