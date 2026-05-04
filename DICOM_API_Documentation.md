# DICOM 影像服务接口文档

> 基于 `js/hp_webapi.js` 源码逆向分析整理，涵盖 Study → Series → Image 全链路数据获取流程。

---

## 目录

1. [接口基础说明](#1-接口基础说明)
2. [接口调用流程](#2-接口调用流程)
3. [API 1：获取 Study/Series/Image 元数据](#3-api-1-获取-studyseriesimage-元数据webpacsapistudy)
4. [API 2：获取图像像素数据（原始）](#4-api-2-获取图像像素数据原始-webpacsapiwado--requesttypegsps)
5. [API 3：获取图像预览（缩略图 URL）](#5-api-3-获取图像预览缩略图-url-webpacsapiwado--requesttypewado)
6. [API 4：获取 DICOM 原始文件](#6-api-4-获取-dicom-原始文件)
7. [API 5：获取测量标注](#7-api-5-获取测量标注-webpacsapimeasurenote)
8. [API 6：保存测量标注](#8-api-6-保存测量标注-webpacsapimeasurenote)
9. [API 7：查询历史检查](#9-api-7-查询历史检查-webpacsapistudyhistory)
10. [API 8：AI 结果查询](#10-api-8-ai-结果查询-webpacsapiairesults)
11. [数据结构说明](#11-数据结构说明)
12. [初始化配置参数](#12-初始化配置参数)

---

## 1. 接口基础说明

### Base URL

| 环境       | Base URL                                           |
|------------|---------------------------------------------------|
| 默认（相对路径）| `/webpacs/api`                                    |
| 局域网模式（mode=l）| `{cfg.server}/new/webpacs/api`            |

### 鉴权方式

所有接口均通过请求头携带 token：

```http
token: {用户令牌}
```

### 通用参数

| 参数       | 说明                                    |
|------------|-----------------------------------------|
| `hospital` | 医院编码，每个请求都必须传入             |
| `d`        | 防缓存时间戳，值为 `new Date().getTime()` |

---

## 2. 接口调用流程

```
┌─────────────────────────────────────────────────────┐
│                   完整调用链路                         │
│                                                      │
│  1. getStudyImages(studyuid)                         │
│     GET /webpacs/api/study?level=study               │
│     → 返回: 患者信息 + series UID 列表                 │
│                    │                                  │
│                    ▼                                  │
│  2. getSeriesImages(studyuid, seriesuid)              │
│     GET /webpacs/api/study?level=image               │
│     → 返回: 该序列所有 image 元数据列表                │
│          (imageuid / rows / columns / sliceloction…) │
│                    │                                  │
│                    ▼                                  │
│  3a. 缩略图预览                                        │
│      getImageUrl(para)                               │
│      GET /webpacs/api/wado?requestType=wado          │
│      → 返回: JPEG 图像（直接用作 <img> src）           │
│                                                      │
│  3b. 原始像素数据（Canvas渲染）                        │
│      getImageData(para, callback)                    │
│      GET /webpacs/api/wado?requestType=gsps          │
│      → 返回: ArrayBuffer 像素数据 + 响应头图像信息      │
└─────────────────────────────────────────────────────┘
```

---

## 3. API 1：获取 Study/Series/Image 元数据（`/webpacs/api/study`）

### 3.1 获取 Study 信息（Series 列表）

**接口地址：**
```
GET /webpacs/api/study
```

**请求参数（Query String）：**

| 参数       | 类型    | 必填 | 说明                            |
|------------|---------|------|---------------------------------|
| `hospital` | string  | ✅   | 医院编码                         |
| `level`    | string  | ✅   | 固定值 `"study"`                 |
| `studyuid` | string  | ✅   | Study Instance UID               |
| `ai`       | integer | ❌   | 是否同时返回 AI 结果，值为 `1`    |
| `d`        | number  | ✅   | 防缓存时间戳                     |

**请求头：**
```http
token: {token}
```

**响应示例：**
```json
{
  "name": "张三",
  "studytime": "2024-01-15 09:30:00",
  "modalities": "CT",
  "sex": "男",
  "series": [
    "1.2.840.10008.5.1.4.1.1.2.1234567",
    "1.2.840.10008.5.1.4.1.1.2.7654321"
  ],
  "airesults": { ... }
}
```

**响应字段说明：**

| 字段         | 类型          | 说明                                    |
|--------------|---------------|-----------------------------------------|
| `name`       | string        | 患者姓名                                 |
| `studytime`  | string        | 检查时间（格式：`YYYY-MM-DD HH:mm:ss`）  |
| `modalities` | string        | 检查模态（CT / MR / CR / DX / MG / XA） |
| `sex`        | string        | 患者性别                                 |
| `series`     | string[]      | Series Instance UID 数组（按序列号排序） |
| `airesults`  | object        | AI 分析结果（仅 `ai=1` 时返回）          |

**错误处理：**

| HTTP 状态码 | 含义         |
|-------------|--------------|
| 401         | 链接已失效   |
| 超时        | 请求超时     |
| 其他错误    | 参数错误     |

---

### 3.2 获取 Series 下的 Image 列表

**接口地址：**
```
GET /webpacs/api/study
```

**请求参数（Query String）：**

| 参数        | 类型   | 必填 | 说明                             |
|-------------|--------|------|----------------------------------|
| `hospital`  | string | ✅   | 医院编码                          |
| `level`     | string | ✅   | 固定值 `"image"`                  |
| `studyuid`  | string | ✅   | Study Instance UID                |
| `seriesuid` | string | ✅   | Series Instance UID               |
| `d`         | number | ✅   | 防缓存时间戳                      |

**请求头：**
```http
token: {token}
```

**响应示例：**
```json
{
  "data": [
    {
      "imageuid": "1.2.840.10008.5.1.4.1.1.2.111",
      "rows": 512,
      "columns": 512,
      "numberofframes": 1,
      "imageno": 1,
      "seriesno": "1",
      "pixelspacing": "0.703125\\0.703125",
      "sliceloction": "-120.50",
      "pat_name": "张三",
      "patid": "P20240001",
      "age": "045Y",
      "sex": "M",
      "model_name": "SOMATOM Definition Flash",
      "manufacturer": "SIEMENS",
      "institution_name": "某某医院",
      "series_date": "20240115",
      "series_desc": "胸部平扫",
      "series_no": "3",
      "slice_thick": "5.0",
      "studyid": "20240115001",
      "study_desc": "胸部CT"
    }
  ]
}
```

**响应 `data` 数组中每个元素字段说明：**

| 原始字段名          | 前端映射字段名    | 类型    | 说明                                  |
|--------------------|-----------------|---------|---------------------------------------|
| `imageuid`         | `objectUID`     | string  | SOP Instance UID（图像唯一标识）        |
| `rows`             | `Rows`          | integer | 图像行数（像素高度）                    |
| `columns`          | `Columns`       | integer | 图像列数（像素宽度）                    |
| `numberofframes`   | —               | integer | 帧数（>1 表示多帧序列，如 XA）          |
| `imageno`          | —               | integer | 图像编号（Instance Number）             |
| `seriesno`         | —               | string  | 序列号（Series Number）                 |
| `pixelspacing`     | `PixelSpacing`  | string  | 像素间距（格式：`行间距\\列间距`，单位 mm）|
| `sliceloction`     | `SliceLoction`  | string  | 切片位置（Slice Location，单位 mm）     |
| `pat_name`         | —               | string  | 患者姓名                               |
| `patid`            | —               | string  | 患者 ID                                |
| `age`              | —               | string  | 患者年龄（如 `045Y`）                   |
| `sex`              | —               | string  | 患者性别（`M` / `F`）                  |
| `model_name`       | —               | string  | 设备型号                               |
| `manufacturer`     | —               | string  | 设备制造商                             |
| `institution_name` | —               | string  | 机构/医院名称                          |
| `series_date`      | —               | string  | 序列日期（格式：`YYYYMMDD`）            |
| `series_desc`      | —               | string  | 序列描述（Series Description）          |
| `series_no`        | —               | string  | 序列号                                 |
| `slice_thick`      | —               | string  | 切片厚度（Slice Thickness，单位 mm）    |
| `studyid`          | —               | string  | 检查 ID（Study ID / Accession Number） |
| `study_desc`       | —               | string  | 检查描述（Study Description）           |

> **注意：** `studyUID` 和 `seriesUID` 由客户端代码在数据回调中动态注入（非服务端字段）。

---

## 4. API 2：获取图像像素数据（原始） `/webpacs/api/wado` + `requestType=gsps`

用于 Canvas 直接渲染，服务端返回原始像素 ArrayBuffer，图像元信息通过响应头传递。

**接口地址：**
```
GET /webpacs/api/wado
```

**请求参数（Query String）：**

| 参数          | 类型    | 必填 | 说明                                    |
|---------------|---------|------|-----------------------------------------|
| `hospital`    | string  | ✅   | 医院编码                                 |
| `requestType` | string  | ✅   | 固定值 `"gsps"`                          |
| `studyUID`    | string  | ✅   | Study Instance UID                       |
| `seriesUID`   | string  | ✅   | Series Instance UID                      |
| `objectUID`   | string  | ✅   | SOP Instance UID（即 imageuid）           |
| `token`       | string  | ✅   | 用户令牌（作为 Query 参数传递）            |
| `rows`        | integer | ❌   | 期望输出的图像高度（像素），不传则原始大小  |
| `columns`     | integer | ❌   | 期望输出的图像宽度（像素），不传则原始大小  |
| `frameNumber` | integer | ❌   | 指定帧号（多帧图像必传，从 1 开始）        |
| `ts`          | number  | ✅   | 防缓存时间戳 `new Date().getTime()`       |

**请求方式：** XHR，`responseType = 'arraybuffer'`

**响应体：**

| 响应形式     | 条件               | 数组类型       | 说明                      |
|--------------|--------------------|----------------|---------------------------|
| `Uint8Array` | BitType = 1        | 8位无符号      | 8位灰度图（如部分 CR/DX） |
| `Int16Array` | BitType = 2        | 16位有符号整数 | 16位灰度图（CT/MR 主流）  |
| `Uint8Array` | BitType = 3        | 8位无符号      | RGB 彩色图（3通道）        |

> **BitType 计算方法：** `byteLength / width / height`

**响应头字段说明：**

| 响应头字段名           | 类型   | 说明                                                   |
|------------------------|--------|--------------------------------------------------------|
| `width`                | string | 实际返回图像宽度（像素）                                |
| `height`               | string | 实际返回图像高度（像素）                                |
| `Frameno`              | string | 当前图像帧号                                            |
| `inverse`              | string | 是否反相（`"1"` = 反相，`"0"` = 正常）                 |
| `default_center`       | string | 默认窗位（Window Center）                               |
| `default_window`       | string | 默认窗宽（Window Width）                                |
| `Patient_orientation`  | string | 患者方向（如 `"L\\P"`）                                 |
| `Image_laterality`     | string | 图像侧别（`L` / `R`）                                   |
| `View_position`        | string | 投照体位（如 `AP`、`PA`、`LL`）                         |
| `Image_type`           | string | 图像类型（如 `ORIGINAL\\PRIMARY\\AXIAL`，`\\`分隔）     |
| `Text_annotations`     | string | JSON 字符串，包含文字标注数组（见下方结构）             |
| `imageinfo`            | string | JSON 字符串，包含完整 DICOM 元数据（见下方结构）        |

**`imageinfo` 响应头 JSON 字段详解：**

| 字段名              | 类型   | 说明                                              |
|--------------------|--------|---------------------------------------------------|
| `modality`         | string | 影像模态（CT / MR / CR / DX / MG / XA 等）        |
| `Modality`         | string | 同 `modality`（兼容字段，代码中赋值 `info.Modality = info.modality`）|
| `winwidth`         | string | DICOM 标签建议窗宽                                |
| `WinWidth`         | string | 同 `winwidth`（兼容字段）                         |
| `wincenter`        | string | DICOM 标签建议窗位                                |
| `WinCenter`        | string | 同 `wincenter`（兼容字段）                        |
| `name`             | string | 患者姓名（Patient Name）                          |
| `patientid`        | string | 患者 ID（Patient ID）                             |
| `sex`              | string | 患者性别                                          |
| `age`              | string | 患者年龄                                          |
| `seriesdesc`       | string | 序列描述（Series Description）                    |
| `seriestime`       | string | 序列时间                                          |
| `seriesno`         | string | 序列号                                            |
| `studydesc`        | string | 检查描述（Study Description）                     |
| `studyno`          | string | 检查号（Study ID）                                |
| `slicethick`       | string | 切片厚度（Slice Thickness，单位 mm）              |
| `sliceloction`     | string | 切片位置（Slice Location，单位 mm）               |
| `pixelspacing`     | string | 像素间距（格式：`行间距\\列间距`，单位 mm）        |
| `imgpos`           | string | 图像位置（Image Position Patient，格式：`x\\y\\z`）|
| `imageorientation` | string | 图像方向余弦（Image Orientation Patient，格式：`r0\\r1\\r2\\c0\\c1\\c2`）|
| `manufact`         | string | 设备制造商（Manufacturer）                        |
| `manufactmodel`    | string | 设备型号（Manufacturer's Model Name）             |
| `institution`      | string | 机构名称（Institution Name）                      |
| `rescale_type`     | string | 像素值单位（如 `"HU"` 表示 Hounsfield Unit，用于 CT）|

> **多值字段说明：** `winwidth` / `wincenter` 可能含多个值，以 `\\` 分隔，客户端取第一个值。

**`Text_annotations` JSON 数组元素结构：**

```json
[
  {
    "value": "标注文字内容",
    "box_topleft": "x1\\y1",
    "box_bottomright": "x2\\y2"
  }
]
```

**客户端处理后的完整响应对象结构（传入 callback）：**

```javascript
{
  data: Int16Array | Uint8Array,  // 像素数据
  size: number,                   // 数据大小（MB）
  para: Object,                   // 原始请求参数
  type: number,                   // 1=8位灰度, 2=16位灰度, 3=RGB彩色
  frameNo: number,                // 当前帧号
  width: string,                  // 图像宽度
  height: string,                 // 图像高度
  Inverse: string,                // 是否反相
  Defaultcenter: string,          // 默认窗位
  Defaultwindow: string,          // 默认窗宽
  Patient_orientation: string,    // 患者方向
  Image_laterality: string,       // 图像侧别
  View_position: string,          // 投照体位
  Image_type: string,             // 图像类型
  Text_annotations: Array,        // 文字标注数组
  info: {                         // 来自 imageinfo 响应头
    modality: string,
    Modality: string,
    winwidth: string,
    WinWidth: string,
    wincenter: string,
    WinCenter: string,
    name: string,
    patientid: string,
    sex: string,
    age: string,
    seriesdesc: string,
    seriestime: string,
    seriesno: string,
    studydesc: string,
    studyno: string,
    slicethick: string,
    sliceloction: string,
    pixelspacing: string,
    imgpos: string,
    imageorientation: string,
    manufact: string,
    manufactmodel: string,
    institution: string,
    rescale_type: string
  }
}
```

---

## 5. API 3：获取图像预览（缩略图 URL） `/webpacs/api/wado` + `requestType=wado`

返回 JPEG 格式图像 URL，可直接用于 `<img>` 标签或缩略图展示。

**URL 构造方式（客户端拼接）：**
```
/webpacs/api/wado
  ?hospital={hospital}
  &requestType=wado
  &studyUID={studyUID}
  &seriesUID={seriesUID}
  &objectUID={objectUID}
  &token={token}
  &rows={rows}
  &columns={columns}
  &imageQuality={quality}
  &ts={timestamp}
```

**参数说明：**

| 参数           | 类型    | 必填 | 说明                                    |
|----------------|---------|------|-----------------------------------------|
| `hospital`     | string  | ✅   | 医院编码                                 |
| `requestType`  | string  | ✅   | 固定值 `"wado"`                          |
| `studyUID`     | string  | ✅   | Study Instance UID                       |
| `seriesUID`    | string  | ✅   | Series Instance UID                      |
| `objectUID`    | string  | ✅   | SOP Instance UID（即 imageuid）           |
| `token`        | string  | ✅   | 用户令牌                                 |
| `rows`         | integer | ❌   | 期望输出高度（缩略图场景传小值）           |
| `columns`      | integer | ❌   | 期望输出宽度（缩略图场景传小值）           |
| `imageQuality` | integer | ❌   | JPEG 压缩质量（0-100），默认 `50`          |
| `ts`           | number  | ✅   | 防缓存时间戳                             |

**响应：** 直接返回 JPEG 图像二进制流（`Content-Type: image/jpeg`）

**使用示例：**
```html
<img src="/webpacs/api/wado?hospital=HOS001&requestType=wado&studyUID=1.2.3&seriesUID=1.2.3.1&objectUID=1.2.3.1.1&token=xxx&rows=128&columns=128&imageQuality=50&ts=1700000000000" />
```

---

## 6. API 4：获取 DICOM 原始文件

下载完整的 DICOM 文件（不压缩）。

**URL 构造方式：**
```
/webpacs/api/wado
  ?hospital={hospital}
  &requestType=wado
  &studyUID={studyUID}
  &seriesUID={seriesUID}
  &objectUID={objectUID}
  &token={token}
  &rows={rows}
  &columns={columns}
  &ts={timestamp}
  &contentType=application/dicom
```

**与 API 3 的区别：** 追加 `&contentType=application/dicom` 参数，服务端返回完整 DICOM 文件而非 JPEG 图像。

---

## 7. API 5：获取测量标注 `/webpacs/api/measurenote`

**接口地址：**
```
GET /webpacs/api/measurenote
```

**请求参数（Query String）：**

| 参数        | 类型   | 必填 | 说明               |
|-------------|--------|------|--------------------|
| `hospital`  | string | ✅   | 医院编码            |
| `studyUID`  | string | ✅   | Study Instance UID  |
| `seriesUID` | string | ✅   | Series Instance UID |
| `d`         | number | ✅   | 防缓存时间戳        |

**请求头：**
```http
token: {token}
```

**响应结构（以 objectUID 为 key，标注数组为 value）：**
```json
{
  "1.2.840.10008.5.1.4.1.1.2.111": [
    {
      "sdx": 100.5,
      "sdy": 200.3,
      "tdx": 150.0,
      "tdy": 230.8,
      "edx": 180.0,
      "edy": 260.0,
      "frameNo": 1,
      "type": "line"
    }
  ]
}
```

---

## 8. API 6：保存测量标注 `/webpacs/api/measurenote`

**接口地址：**
```
POST /webpacs/api/measurenote
```

**请求参数（Query String）：**

| 参数        | 类型   | 必填 | 说明               |
|-------------|--------|------|--------------------|
| `hospital`  | string | ✅   | 医院编码            |
| `studyUID`  | string | ✅   | Study Instance UID  |
| `seriesUID` | string | ✅   | Series Instance UID |
| `objectUID` | string | ✅   | SOP Instance UID    |

**请求头：**
```http
token: {token}
Content-Type: application/json
```

**请求体：** 标注数组的 JSON 字符串

```json
[
  {
    "sdx": 100.5,
    "sdy": 200.3,
    "tdx": 150.0,
    "tdy": 230.8,
    "frameNo": 1,
    "type": "line"
  }
]
```

> **多帧处理逻辑：** 对多帧图像（`numberofframes > 1`），客户端会合并不同帧的标注，保存时发送该图像 UID 下所有帧的完整标注集合。

---

## 9. API 7：查询历史检查 `/webpacs/api/study/history`

**接口地址：**
```
GET /webpacs/api/study/history
```

**请求参数（Query String）：**

| 参数        | 类型   | 必填 | 说明               |
|-------------|--------|------|--------------------|
| `hospital`  | string | ✅   | 医院编码            |
| `studyuid`  | string | ✅   | Study Instance UID  |

**请求头：**
```http
token: {token}
```

**响应结构：**
```json
{
  "data": [
    {
      "studytime": "2024-01-10 08:00:00",
      "modalities": "CT",
      "bodypart": "胸部",
      "studydesc": "胸部CT平扫",
      "hospcode": "HOS001",
      "studyuid": "1.2.840.xxxx"
    }
  ]
}
```

**响应 `data` 数组字段说明：**

| 字段        | 类型   | 说明           |
|-------------|--------|----------------|
| `studytime` | string | 检查时间        |
| `modalities`| string | 检查模态        |
| `bodypart`  | string | 检查部位        |
| `studydesc` | string | 检查描述        |
| `hospcode`  | string | 医院编码        |
| `studyuid`  | string | Study UID       |

---

## 10. API 8：AI 结果查询 `/webpacs/api/airesults`

**接口地址：**
```
GET /webpacs/api/airesults
```

**请求参数（Query String）：**

| 参数        | 类型   | 必填 | 说明               |
|-------------|--------|------|--------------------|
| `hospital`  | string | ✅   | 医院编码            |
| `studyuid`  | string | ✅   | Study Instance UID  |
| `seriesuid` | string | ❌   | Series Instance UID |
| `d`         | number | ✅   | 防缓存时间戳        |

**请求头：**
```http
token: {token}
```

> **注意：** 该接口通常不需要单独调用，AI 结果已包含在 `getStudyImages（level=study, ai=1）` 的 `airesults` 字段中返回。

---

## 11. 数据结构说明

### 11.1 前端数据流转路径

```
getStudyImages()
    └─► webapi.allSeries = [ series1Images[], series2Images[], ... ]
                                    │
                                    ▼
          每个 series 数组中的 image 对象（经客户端字段映射后）：
          {
            // 来自 API level=image 响应，原始字段：
            imageuid, rows, columns, numberofframes, imageno, seriesno,
            pixelspacing, sliceloction, pat_name, patid, age, sex,
            model_name, manufacturer, institution_name, series_date,
            series_desc, series_no, slice_thick, studyid, study_desc,

            // 客户端动态注入字段：
            studyUID,      // 来自调用参数
            seriesUID,     // 来自调用参数
            objectUID,     // = imageuid
            Rows,          // = rows
            Columns,       // = columns
            PixelSpacing,  // = pixelspacing
            SliceLoction,  // = sliceloction
            frameNo,       // 当前显示帧（默认1，多帧时动态更新）
            imageIndex     // 在序列中的下标
          }
```

### 11.2 图像渲染参数对象（传入 wado API 的 `para`）

```javascript
{
  studyUID: "1.2.840...",     // Study UID
  seriesUID: "1.2.840...",    // Series UID
  objectUID: "1.2.840...",    // SOP Instance UID
  rows: 512,                  // 请求图像高度（可选）
  columns: 512,               // 请求图像宽度（可选）
  frameNo: 1                  // 帧号（多帧图像必填）
}
```

### 11.3 窗宽窗位使用逻辑

```
优先使用 imageinfo.WinWidth / WinCenter（DICOM 标签推荐值）
    │ 若为空
    ▼
使用 Defaultwindow / Defaultcenter（响应头，服务端计算值）
    │ 若含多值（如 "400\\200"），取第一个值（\\前的部分）
    ▼
最终设置：
  winWidth = 数值
  winCenter = 数值
  start = winCenter - winWidth / 2
  end   = winCenter + winWidth / 2
```

### 11.4 图像方向计算所需字段

用于定位线（Localizer）和空间坐标计算：

| 字段                | 格式                          | 说明                       |
|---------------------|-------------------------------|----------------------------|
| `imgpos`            | `"x\\y\\z"`                   | 图像左上角的空间坐标（mm）  |
| `imageorientation`  | `"r0\\r1\\r2\\c0\\c1\\c2"`    | 行方向和列方向的单位向量    |
| `pixelspacing`      | `"row_spacing\\col_spacing"`  | 像素间距（mm）              |

---

## 12. 初始化配置参数

`HPWebApi` 构造函数接收的配置对象：

```javascript
var webapi = new HPWebApi({
  token: "用户令牌",           // 必填：鉴权 token
  hospital: "医院编码",        // 必填：医院代码
  dialog: dialogInstance,      // 必填：对话框实例（用于错误提示）
  mode: "l",                   // 可选："l" 表示局域网模式，使用 cfg.server 作为 Base URL
  server: "http://192.168.1.1" // mode="l" 时必填：服务器地址
});
```

**调用示例（完整流程）：**

```javascript
// 1. 初始化
var webapi = new HPWebApi({
  token: 'eyJhbGciOiJIUzI1NiJ9...',
  hospital: 'HOS001',
  dialog: myDialog
});

// 2. 获取 Study 下所有序列和图像
webapi.getStudyImages('1.2.840.10008.5.1.4.1.1.2.STUDY001');
var allImages = webapi.allSeries;
// allImages[0] = 第1个序列的图像数组
// allImages[1] = 第2个序列的图像数组

// 3. 获取缩略图 URL（用于序列面板）
var para = {
  studyUID: allImages[0][0].studyUID,
  seriesUID: allImages[0][0].seriesUID,
  objectUID: allImages[0][0].objectUID,
  rows: 128,
  columns: 128
};
var thumbUrl = webapi.getImageUrl(para);
// <img src="{thumbUrl}">

// 4. 获取原始像素数据（用于 Canvas 渲染）
var para = {
  studyUID: allImages[0][0].studyUID,
  seriesUID: allImages[0][0].seriesUID,
  objectUID: allImages[0][0].objectUID,
  rows: 512,
  columns: 512,
  frameNo: 1
};
webapi.getImageData(para, function(res) {
  if (!res) return; // 加载失败
  console.log(res.data);       // Int16Array / Uint8Array
  console.log(res.info);       // 图像元信息
  console.log(res.width);      // 图像宽度
  console.log(res.height);     // 图像高度
  console.log(res.Defaultwindow, res.Defaultcenter); // 推荐窗宽窗位
});
```

---

*文档版本：1.0 | 生成日期：2026-04-28 | 来源：cloud-film 项目源码分析*
