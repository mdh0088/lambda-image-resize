'use strict';

const querystring = require('querystring'); // 설치하지 않아도 됨
const AWS = require('aws-sdk'); // 설치 해야함
const Sharp = require('sharp'); // 설치 해야함

const S3 = new AWS.S3({
  region: 'ap-northeast-2',
});
const BUCKET = 'static.sajuline.com';
const MB = 1024 * 1024;

exports.handler = async (event, context, callback) => {
  console.log('Full event:', JSON.stringify(event, null, 2));

  if (!event.Records || event.Records.length === 0 || !event.Records[0].cf) {
    console.log('Invalid event structure or missing CloudFront data.');
    return callback(null, {
      status: 400,
      body: 'Invalid event structure',
    });
  }

  const { request, response } = event.Records[0].cf;
  console.log('Request:', request);
  console.log('Response:', response);

  // Querystring 파싱
  const params = querystring.parse(request.querystring);

  // URI에서 파일 이름과 확장자 추출
  const { uri } = request;
  const match = uri.match(/\/?(.*)\.(.*)/);
  if (!match) {
    console.log('Invalid URI:', uri);
    return callback(new Error('Invalid URI format'));
  }

  const [, fileName, extension] = match;

  // 확장자가 이미지 포맷인지 확인
  const imageExtensions = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
  const isImageFile = imageExtensions.includes(extension.toLowerCase());

  // 이미지가 아니면 원본 파일 그대로 반환
  if (!isImageFile) {
    console.log(`File is not an image. Returning original response for ${fileName}.${extension}`);
    return callback(null, response);
  }

  // S3에서 파일 가져오기
  let s3Object;
  try {
    s3Object = await S3.getObject({
      Bucket: BUCKET,
      Key: decodeURI(fileName + '.' + extension),
    }).promise();
  } catch (error) {
    if (error.code === 'NoSuchKey') {
      console.log('File not found in S3. Returning original response.');
      return callback(null, response);
    }
    console.log('S3.getObject error:', error);
    return callback(error);
  }

  // 파라미터가 없으면 원본 이미지 반환
  if (!params.w && !params.h && !params.q && !params.f) {
    console.log('No resizing parameters provided. Returning original image.');
    response.status = 200;
    response.body = s3Object.Body.toString('base64');
    response.bodyEncoding = 'base64';
    response.headers['content-type'] = [
      {
        key: 'Content-Type',
        value: `image/${extension}`,
      },
    ];
    return callback(null, response);
  }

  // 이미지 리사이징 처리
  let resizedImage;
  let metadata;
  try {
    resizedImage = await Sharp(s3Object.Body).rotate();
    metadata = await resizedImage.metadata();
    console.log('Image Metadata:', metadata);
  } catch (error) {
    console.log('Sharp error:', error);
    return callback(error);
  }

  try {
    // 리사이즈 조건 확인 및 적용
    const width = parseInt(params.w, 10) || null;
    const height = parseInt(params.h, 10) || null;
    const quality = parseInt(params.q, 10) || null;
    const format = params.f || 'webp';

    if ((width || height) && (metadata.width >= width || metadata.height >= height)) {
      resizedImage = resizedImage.resize(width, height);
    }

    // 포맷 및 품질 적용
    resizedImage = await resizedImage.toFormat(format, { quality }).toBuffer();
  } catch (error) {
    console.log('Sharp resize/format error:', error);
    return callback(error);
  }

  const resizedImageByteLength = Buffer.byteLength(resizedImage, 'base64');
  console.log('Resized Image Byte Length:', resizedImageByteLength);

  // 이미지가 1MB보다 큰 경우 원본 반환
  if (resizedImageByteLength > MB) {
    console.log('Image exceeds 1MB. Returning original response.');
    return callback(null, response);
  }

  // CloudFront 응답 설정
  response.status = 200;
  response.body = resizedImage.toString('base64');
  response.bodyEncoding = 'base64';
  response.headers['content-type'] = [
    {
      key: 'Content-Type',
      value: `image/${params.f || 'webp'}`,
    },
  ];

  console.log('Image processed and response sent.');
  return callback(null, response);
};
