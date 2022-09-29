require("dotenv").config();

const fs = require("fs");
const path = require("path");
const _ = require("lodash");
const moment = require("moment");
const axios = require("axios");
const SFTPClient = require("ssh2-sftp-client");
const HttpsProxyAgent = require("https-proxy-agent");
const qs = require("qs");
const xlsx = require("xlsx");
const { asyncPool, getErrorMessage } = require("./utils");

const issuer = "https://qyapi.weixin.qq.com/cgi-bin";

const isLocal = () => process.env.ENV === "local";

function setHttpsProxyAgent() {
  if (process.env.HTTPS_PROXY) {
    const httpsAgent = new HttpsProxyAgent(process.env.HTTPS_PROXY);
    axios.defaults.httpsAgent = httpsAgent;
  }
}

async function fetchAccessToken() {
  const begin = moment();
  const corpId = process.env.CROP_ID;
  const corpSecret = process.env.CROP_SECRET;
  const queries = qs.stringify({ corpid: corpId, corpsecret: corpSecret });
  const response = await axios.default.get(`${issuer}/gettoken?${queries}`);
  const accessToken = response.data.access_token;
  const duration = moment().diff(begin, "milliseconds");
  console.log(
    `Fetched access token successfully, it cost ${duration} milliseconds!`
  );
  return accessToken;
}

async function fetchUsers(accessToken, departmentIds) {
  const begin = moment();
  const responses = await asyncPool(departmentIds, (departmentId) => {
    const queries = qs.stringify({
      access_token: accessToken,
      department_id: departmentId,
    });
    return axios.default.get(`${issuer}/user/simplelist?${queries}`);
  });
  const users = _.flatMap(responses, "data.userlist");
  const duration = moment().diff(begin, "milliseconds");
  console.log(`Fetched users successfully, it cost ${duration} milliseconds!`);
  return users;
}

async function fetcTaghUsers(accessToken, tagIds) {
  const begin = moment();
  const responses = await asyncPool(tagIds, (tagId) => {
    const queries = qs.stringify({
      access_token: accessToken,
      tagid: tagId,
    });
    return axios.default.get(`${issuer}/tag/get?${queries}`);
  });
  const tagUsers = _.flatMap(responses, "data.userlist");
  const duration = moment().diff(begin, "milliseconds");
  console.log(
    `Fetched tag users successfully, it cost ${duration} milliseconds!`
  );
  return tagUsers;
}

async function fetchExternalContacts(accessToken, userIds) {
  const begin = moment();
  const fetchBatchExternalContacts = async (userIds, cursor) => {
    if (userIds.length === 0) {
      return [];
    }
    const response = await axios.default.post(
      `${issuer}/externalcontact/batch/get_by_user?access_token=${accessToken}`,
      { userid_list: userIds, limit: 100, cursor }
    );
    const batchExternalContacts = [...response.data.external_contact_list];
    if (response.data.next_cursor) {
      const nextBatchExternalContacts = await fetchBatchExternalContacts(
        userIds,
        response.data.next_cursor
      );
      batchExternalContacts.push(...nextBatchExternalContacts);
    }
    return batchExternalContacts;
  };
  const externalContacts = await asyncPool(
    _.chunk(userIds, 100),
    (chunkedUserIds) => fetchBatchExternalContacts(chunkedUserIds),
    5
  ).then(_.flatMap);
  const duration = moment().diff(begin, "milliseconds");
  console.log(
    `Fetched external contacts successfully, it cost ${duration} milliseconds!`
  );
  return externalContacts;
}

function generateExternalContactExcel(externalContacts, tagUsers) {
  const begin = moment();
  const aoa = [];
  aoa.push([
    "代表邮箱",
    "客户姓名",
    "企微企业名称",
    "微信企业备注",
    "UnionID",
    "添加外部联系人的时间",
    "标签",
  ]);
  _.each(externalContacts, (externalContact) => {
    const userId = _.get(externalContact, "follow_info.userid");
    aoa.push([
      `${userId}@merck.com`,
      _.get(externalContact, "external_contact.name"),
      _.get(externalContact, "external_contact.corp_name"),
      _.get(externalContact, "follow_info.remark_corp_name"),
      _.get(externalContact, "external_contact.unionid"),
      moment(_.get(externalContact, "follow_info.createtime") * 1000).format(
        "YYYY/MM/DD hh:mm:ss"
      ),
      _.find(tagUsers, { userid: userId }) ? "APP-研而有信" : "",
    ]);
  });
  const worksheet = xlsx.utils.aoa_to_sheet(aoa);
  const stream = xlsx.stream.to_csv(worksheet);
  const duration = moment().diff(begin, "milliseconds");
  console.log(`Fetched users successfully, it cost ${duration} milliseconds!`);
  return stream;
}

function saveFile(stream, fileName) {
  const filePath = path.join(process.cwd(), fileName);
  stream.pipe(fs.WriteStream(filePath));
}

async function uploadFile(stream, fileName) {
  const begin = moment();
  const host = _.toString(process.env.SFTP_HOST);
  const port = _.toNumber(process.env.SFTP_PORT);
  const username = _.toString(process.env.SFTP_USERNAME);
  const password = _.toString(process.env.SFTP_PASSWORD);
  const filePath = path.join(process.env.SFTP_PATH, fileName);
  const client = new SFTPClient({ host, port, username, password });
  let duration = moment().diff(begin, "milliseconds");
  console.log(`Connected sftp successfully, it cost ${duration} milliseconds!`);
  await client.put(stream, filePath);
  duration = moment().diff(begin, "milliseconds");
  console.log(`Uploaded file successfully, it cost ${duration} milliseconds!`);
}

exports.handler = async function (event, context) {
  try {
    const begin = moment();
    setHttpsProxyAgent();
    const accessToken = await fetchAccessToken();
    const departmentIds = _.split(process.env.DEPARTMENT_IDS, ",");
    const users = await fetchUsers(accessToken, departmentIds);
    const tagIds = _.split(process.env.TAG_IDS, ",");
    const tagUsers = await fetcTaghUsers(accessToken, tagIds);
    const userIds = _.map(users, "userid");
    const externalContacts = await fetchExternalContacts(accessToken, userIds);
    const stream = generateExternalContactExcel(externalContacts, tagUsers);
    const fileName = `Medical_External_Contact_${moment().format(
      "YYYYMMDD"
    )}.csv`;
    if (isLocal()) {
      saveFile(stream, fileName);
    } else {
      await uploadFile(stream, fileName);
    }
    const duration = moment().diff(begin, "seconds");
    console.log(`Handler execution successfully, it cost ${duration} seconds!`);
    return {
      statusCode: 200,
      body: "ok",
    };
  } catch (error) {
    console.error("Exception occurred: ", getErrorMessage(error));
    return {
      statusCode: 500,
      body: "Internal Server Error",
    };
  }
};

if (isLocal()) {
  this.handler();
}
