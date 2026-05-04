import dcmjs from 'dcmjs';
import dicomImageLoader from '@cornerstonejs/dicom-image-loader';
import { metaData as cornerstoneMetaData } from '@cornerstonejs/core';
import { DicomMetadataStore, IWebApiDataSource, utils, classes } from '@ohif/core';

import { processResults, processSeriesResults } from '../DicomWebDataSource/qido.js';
import {
  retrieveStudyMetadata,
  deleteStudyMetadataPromise,
} from '../DicomWebDataSource/retrieveStudyMetadata.js';

const { naturalizeDataset, denaturalizeDataset } = dcmjs.data.DicomMetaDictionary;
const metadataProvider = classes.MetadataProvider;

const DEFAULT_API_ROOT = '/webpacs/api';
const DEFAULT_THUMBNAIL_ROWS = 256;
const DEFAULT_THUMBNAIL_COLUMNS = 256;
const DEFAULT_THUMBNAIL_QUALITY = 60;
const DEFAULT_METADATA_CONCURRENCY = 4;

function createCompanyApi(userConfig = {}, servicesManager) {
  const { userAuthenticationService } = servicesManager.services;

  let runtimeContext = {
    params: null,
    query: null,
  };

  let config = {
    name: 'companyapi',
    apiRoot: DEFAULT_API_ROOT,
    imageRendering: 'wadouri',
    thumbnailRows: DEFAULT_THUMBNAIL_ROWS,
    thumbnailColumns: DEFAULT_THUMBNAIL_COLUMNS,
    thumbnailQuality: DEFAULT_THUMBNAIL_QUALITY,
    metadataRequestConcurrency: DEFAULT_METADATA_CONCURRENCY,
    tokenHeaderName: 'token',
    tokenQueryParam: 'token',
    hospitalQueryParam: 'hospital',
    ...userConfig,
  };

  const studySummaryCache = new Map();
  const seriesImagesCache = new Map();
  const instanceMetadataCache = new Map();
  const requestTimestamp = Date.now();

  const normalizeRoot = value => {
    if (!value) {
      return DEFAULT_API_ROOT;
    }

    return value.replace(/\/+$/, '');
  };

  const getApiRoot = () => {
    if (config.mode === 'l' && config.server) {
      return normalizeRoot(`${config.server}/new/webpacs/api`);
    }

    return normalizeRoot(config.apiRoot);
  };

  const getQueryValue = key => {
    const query = runtimeContext.query;
    if (!query || typeof query.get !== 'function') {
      return undefined;
    }

    const value = query.get(key);
    return value === null ? undefined : value;
  };

  const getAuthorizationHeaders = () => {
    return userAuthenticationService?.getAuthorizationHeader?.() || {};
  };

  const extractTokenFromAuthorization = authorizationHeader => {
    if (!authorizationHeader || typeof authorizationHeader !== 'string') {
      return undefined;
    }

    const bearerPrefix = 'Bearer ';
    if (authorizationHeader.startsWith(bearerPrefix)) {
      return authorizationHeader.slice(bearerPrefix.length);
    }

    return authorizationHeader;
  };

  const getToken = () => {
    if (config.token) {
      return config.token;
    }

    const authHeaders = getAuthorizationHeaders();
    if (authHeaders[config.tokenHeaderName]) {
      return authHeaders[config.tokenHeaderName];
    }

    if (authHeaders.token) {
      return authHeaders.token;
    }

    const authorizationToken = extractTokenFromAuthorization(authHeaders.Authorization);
    if (authorizationToken) {
      return authorizationToken;
    }

    return getQueryValue(config.tokenQueryParam);
  };

  const getHospital = () => {
    if (config.hospital) {
      return config.hospital;
    }

    return getQueryValue(config.hospitalQueryParam);
  };

  const getCommonQueryParams = () => {
    const hospital = getHospital();
    if (!hospital) {
      throw new Error(
        `Company API requires hospital. Provide it in config.hospital or query parameter "${config.hospitalQueryParam}".`
      );
    }

    return {
      hospital,
    };
  };

  const buildHeaders = (baseHeaders = {}) => {
    const headers = {
      ...baseHeaders,
    };

    const token = getToken();
    if (token) {
      headers[config.tokenHeaderName] = token;
    }

    return headers;
  };

  const buildUrl = (path, params = {}) => {
    const searchParams = new URLSearchParams();

    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') {
        return;
      }

      searchParams.set(key, String(value));
    });

    const queryString = searchParams.toString();
    const apiRoot = getApiRoot();
    return `${apiRoot}${path}${queryString ? `?${queryString}` : ''}`;
  };

  const throwIfResponseFailed = async response => {
    if (response.ok) {
      return response;
    }

    let bodyText = '';
    try {
      bodyText = await response.text();
    } catch (error) {
      bodyText = '';
    }

    throw new Error(
      `Company API request failed: ${response.status} ${response.statusText}${
        bodyText ? ` - ${bodyText}` : ''
      }`
    );
  };

  const fetchJson = async (path, params = {}) => {
    const response = await fetch(buildUrl(path, params), {
      headers: buildHeaders(),
    });

    await throwIfResponseFailed(response);
    return response.json();
  };

  const fetchArrayBuffer = async url => {
    const response = await fetch(url, {
      headers: buildHeaders(),
    });

    await throwIfResponseFailed(response);
    return response.arrayBuffer();
  };

  const createCacheKey = (...parts) => parts.join('::');

  const toSexCode = sex => {
    if (!sex) {
      return undefined;
    }

    const normalized = String(sex).trim().toUpperCase();
    if (normalized === 'M' || normalized === 'F' || normalized === 'O') {
      return normalized;
    }

    if (sex === '男') {
      return 'M';
    }

    if (sex === '女') {
      return 'F';
    }

    return normalized;
  };

  const toDicomDateTime = dateTimeValue => {
    if (!dateTimeValue) {
      return {};
    }

    const normalized = String(dateTimeValue).trim();
    const match = normalized.match(
      /^(\d{4})[-/]?(\d{2})[-/]?(\d{2})(?:\s+(\d{2}):?(\d{2})(?::?(\d{2}))?)?/
    );

    if (!match) {
      return {};
    }

    const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
    return {
      StudyDate: `${year}${month}${day}`,
      StudyTime: `${hour}${minute}${second}`,
    };
  };

  const splitMultiValue = value => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    if (Array.isArray(value)) {
      return value;
    }

    return String(value)
      .split('\\')
      .map(item => item.trim())
      .filter(Boolean);
  };

  const toInteger = value => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const toFloat = value => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const toNaturalizedStudy = (studyInstanceUID, studySummary) => {
    const dateTime = toDicomDateTime(studySummary.studytime);

    return {
      StudyInstanceUID: studyInstanceUID,
      PatientName: studySummary.name,
      PatientSex: toSexCode(studySummary.sex),
      ModalitiesInStudy: splitMultiValue(studySummary.modalities) || studySummary.modalities,
      NumberOfStudyRelatedSeries: Array.isArray(studySummary.series)
        ? studySummary.series.length
        : undefined,
      ...dateTime,
    };
  };

  const toNaturalizedSeries = ({
    studyInstanceUID,
    seriesInstanceUID,
    instanceCount,
    firstImageRecord,
    studySummary,
  }) => {
    return {
      StudyInstanceUID: studyInstanceUID,
      SeriesInstanceUID: seriesInstanceUID,
      Modality: firstImageRecord?.modality || studySummary?.modalities,
      SeriesNumber: firstImageRecord?.series_no || firstImageRecord?.seriesno,
      SeriesDate: firstImageRecord?.series_date,
      SeriesDescription: firstImageRecord?.series_desc,
      NumberOfSeriesRelatedInstances: instanceCount,
      StudyDescription: firstImageRecord?.study_desc,
      StudyID: firstImageRecord?.studyid,
    };
  };

  const naturalizedToDicomJson = naturalizedDataset => {
    const cleaned = Object.entries(naturalizedDataset).reduce((acc, [key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        acc[key] = value;
      }
      return acc;
    }, {});

    return denaturalizeDataset(cleaned);
  };

  const buildDicomFileUrl = ({ StudyInstanceUID, SeriesInstanceUID, SOPInstanceUID }) => {
    const baseParams = {
      ...getCommonQueryParams(),
      requestType: 'wado',
      studyUID: StudyInstanceUID,
      seriesUID: SeriesInstanceUID,
      objectUID: SOPInstanceUID,
      contentType: 'application/dicom',
      ts: requestTimestamp,
    };

    const token = getToken();
    if (token) {
      baseParams.token = token;
    }

    return buildUrl('/wado', baseParams);
  };

  const buildThumbnailUrl = (instance, options = {}) => {
    const rows = options.rows || config.thumbnailRows || DEFAULT_THUMBNAIL_ROWS;
    const columns = options.columns || config.thumbnailColumns || DEFAULT_THUMBNAIL_COLUMNS;
    const imageQuality =
      options.imageQuality || config.thumbnailQuality || DEFAULT_THUMBNAIL_QUALITY;

    const params = {
      ...getCommonQueryParams(),
      requestType: 'wado',
      studyUID: instance.StudyInstanceUID,
      seriesUID: instance.SeriesInstanceUID,
      objectUID: instance.SOPInstanceUID,
      rows,
      columns,
      imageQuality,
      ts: requestTimestamp,
    };

    const token = getToken();
    if (token) {
      params.token = token;
    }

    return buildUrl('/wado', params);
  };

  const buildImageId = ({ instance, frame }) => {
    const dicomFileUrl = buildDicomFileUrl(instance);
    let imageId = `wadouri:${dicomFileUrl}`;

    const numberOfFrames = Number(instance.NumberOfFrames || 1);
    if (numberOfFrames > 1 && frame !== undefined) {
      imageId += `&frame=${frame}`;
    }

    return imageId;
  };

  class DeferredSeriesPromise {
    metadata = undefined;
    processFunction = undefined;
    internalPromise = undefined;
    completionPromise = undefined;
    thenFunction = undefined;
    rejectFunction = undefined;

    constructor(metadata, processFunction) {
      this.metadata = metadata;
      this.processFunction = processFunction;
    }

    start() {
      if (!this.internalPromise) {
        this.internalPromise = Promise.resolve().then(() => this.processFunction());

        if (this.thenFunction) {
          this.then(this.thenFunction);
          this.thenFunction = undefined;
        }

        if (this.rejectFunction) {
          this.catch(this.rejectFunction);
          this.rejectFunction = undefined;
        }
      }

      return this.internalPromise;
    }

    then(onFulfilled, onRejected) {
      if (this.internalPromise) {
        return this.internalPromise.then(onFulfilled, onRejected);
      }

      this.thenFunction = onFulfilled;
      if (onRejected) {
        this.rejectFunction = onRejected;
      }
    }

    catch(onRejected) {
      if (this.internalPromise) {
        return this.internalPromise.catch(onRejected);
      }

      this.rejectFunction = onRejected;
    }

    waitUntilComplete() {
      return this.completionPromise || this.start();
    }
  }

  const mapWithConcurrency = async (items, limit, worker) => {
    const results = new Array(items.length);
    let nextIndex = 0;

    const runWorker = async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex++;
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    };

    const workerCount = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: workerCount }, runWorker));
    return results;
  };

  const getStudySummary = async studyInstanceUID => {
    const cacheKey = createCacheKey('study', studyInstanceUID);
    if (studySummaryCache.has(cacheKey)) {
      return studySummaryCache.get(cacheKey);
    }

    const promise = fetchJson('/study', {
      ...getCommonQueryParams(),
      level: 'study',
      studyuid: studyInstanceUID,
      d: Date.now(),
    });

    studySummaryCache.set(cacheKey, promise);
    return promise;
  };

  const getSeriesImages = async (studyInstanceUID, seriesInstanceUID) => {
    const cacheKey = createCacheKey('series', studyInstanceUID, seriesInstanceUID);
    if (seriesImagesCache.has(cacheKey)) {
      return seriesImagesCache.get(cacheKey);
    }

    const promise = fetchJson('/study', {
      ...getCommonQueryParams(),
      level: 'image',
      studyuid: studyInstanceUID,
      seriesuid: seriesInstanceUID,
      d: Date.now(),
    }).then(response => response?.data || []);

    seriesImagesCache.set(cacheKey, promise);
    return promise;
  };

  const normalizeUIDList = value => {
    if (!value) {
      return [];
    }

    return (Array.isArray(value) ? value : String(value).split(/[\\,]/))
      .map(item => item.trim())
      .filter(Boolean);
  };

  const sortImageRecords = imageRecords => {
    return [...imageRecords].sort((left, right) => {
      const leftNumber = Number(left?.imageno || left?.InstanceNumber || 0);
      const rightNumber = Number(right?.imageno || right?.InstanceNumber || 0);

      return leftNumber - rightNumber;
    });
  };

  const createSeriesSummaryMetadata = ({
    studyInstanceUID,
    seriesInstanceUID,
    studySummary,
    seriesNumber,
  }) => ({
    StudyInstanceUID: studyInstanceUID,
    SeriesInstanceUID: seriesInstanceUID,
    SeriesNumber: seriesNumber,
    Modality:
      Array.isArray(studySummary?.modalities) ||
      String(studySummary?.modalities || '').includes('\\')
        ? undefined
        : studySummary?.modalities,
  });

  const createLazySeriesLoadPlan = async studyInstanceUID => {
    const studySummary = await getStudySummary(studyInstanceUID);
    const orderedSeriesUIDs = normalizeUIDList(studySummary?.series);

    const seriesSummaryMetadata = orderedSeriesUIDs.map((seriesInstanceUID, index) =>
      createSeriesSummaryMetadata({
        studyInstanceUID,
        seriesInstanceUID,
        studySummary,
        seriesNumber: index + 1,
      })
    );

    return {
      seriesSummaryMetadata,
    };
  };

  const ensureRequiredInstanceTags = (
    dicomJson,
    imageRecord,
    studyInstanceUID,
    seriesInstanceUID
  ) => {
    const naturalizedFallback = {
      StudyInstanceUID: studyInstanceUID,
      SeriesInstanceUID: seriesInstanceUID,
      SOPInstanceUID: imageRecord.imageuid,
      Rows: toInteger(imageRecord.rows),
      Columns: toInteger(imageRecord.columns),
      NumberOfFrames: toInteger(imageRecord.numberofframes),
      InstanceNumber: toInteger(imageRecord.imageno),
      SeriesNumber: toInteger(imageRecord.series_no || imageRecord.seriesno),
      PixelSpacing: splitMultiValue(imageRecord.pixelspacing),
      SliceLocation: toFloat(imageRecord.sliceloction),
      SliceThickness: toFloat(imageRecord.slice_thick),
      PatientName: imageRecord.pat_name,
      PatientID: imageRecord.patid,
      PatientAge: imageRecord.age,
      PatientSex: toSexCode(imageRecord.sex),
      SeriesDescription: imageRecord.series_desc,
      StudyDescription: imageRecord.study_desc,
      StudyID: imageRecord.studyid,
      InstitutionName: imageRecord.institution_name,
      Manufacturer: imageRecord.manufacturer,
      ManufacturerModelName: imageRecord.model_name,
    };

    const fallbackJson = naturalizedToDicomJson(naturalizedFallback);
    return {
      ...fallbackJson,
      ...dicomJson,
    };
  };

  const getInstanceMetadata = async (studyInstanceUID, seriesInstanceUID, imageRecord) => {
    const sopInstanceUID = imageRecord.imageuid;
    const cacheKey = createCacheKey(
      'instance',
      studyInstanceUID,
      seriesInstanceUID,
      sopInstanceUID
    );

    if (instanceMetadataCache.has(cacheKey)) {
      return instanceMetadataCache.get(cacheKey);
    }

    const dicomFileUrl = buildDicomFileUrl({
      StudyInstanceUID: studyInstanceUID,
      SeriesInstanceUID: seriesInstanceUID,
      SOPInstanceUID: sopInstanceUID,
    });
    const imageId = `wadouri:${dicomFileUrl}`;

    const promise = dicomImageLoader.wadouri.dataSetCacheManager
      .load(dicomFileUrl, uri => fetchArrayBuffer(uri), imageId)
      .then(() => {
        const naturalizedInstance = cornerstoneMetaData.get('instance', imageId) || {};
        const dicomJson = naturalizedToDicomJson(naturalizedInstance);

        return ensureRequiredInstanceTags(
          dicomJson,
          imageRecord,
          studyInstanceUID,
          seriesInstanceUID
        );
      });

    instanceMetadataCache.set(cacheKey, promise);
    return promise;
  };

  class CompanyApiClient {
    headers = {};

    async searchForStudies({ studyInstanceUid, studyInstanceUID, queryParams } = {}) {
      let studyUIDs =
        studyInstanceUid ||
        studyInstanceUID ||
        queryParams?.StudyInstanceUID ||
        queryParams?.studyuid;

      if (!studyUIDs) {
        return [];
      }

      studyUIDs = Array.isArray(studyUIDs)
        ? studyUIDs
        : String(studyUIDs)
            .split(/[\\,]/)
            .map(item => item.trim())
            .filter(Boolean);

      const studyDatasets = await Promise.all(
        studyUIDs.map(async uid => {
          const summary = await getStudySummary(uid);
          return naturalizedToDicomJson(toNaturalizedStudy(uid, summary));
        })
      );

      return studyDatasets.filter(Boolean);
    }

    async searchForSeries({ studyInstanceUID, queryParams = {} } = {}) {
      if (!studyInstanceUID) {
        return [];
      }

      const studySummary = await getStudySummary(studyInstanceUID);
      const requestedSeriesUID = queryParams.SeriesInstanceUID;
      const requestedSeriesUIDs = requestedSeriesUID
        ? Array.isArray(requestedSeriesUID)
          ? requestedSeriesUID
          : String(requestedSeriesUID)
              .split(/[\\,]/)
              .map(item => item.trim())
              .filter(Boolean)
        : studySummary.series || [];

      const seriesDatasets = await Promise.all(
        requestedSeriesUIDs.map(async seriesInstanceUID => {
          const images = await getSeriesImages(studyInstanceUID, seriesInstanceUID);
          if (!images.length) {
            return naturalizedToDicomJson(
              toNaturalizedSeries({
                studyInstanceUID,
                seriesInstanceUID,
                instanceCount: 0,
                firstImageRecord: undefined,
                studySummary,
              })
            );
          }

          return naturalizedToDicomJson(
            toNaturalizedSeries({
              studyInstanceUID,
              seriesInstanceUID,
              instanceCount: images.length,
              firstImageRecord: images[0],
              studySummary,
            })
          );
        })
      );

      return seriesDatasets.filter(Boolean);
    }

    async retrieveStudyMetadata({ studyInstanceUID } = {}) {
      const studySummary = await getStudySummary(studyInstanceUID);
      const seriesUIDs = studySummary.series || [];
      const seriesMetadata = await Promise.all(
        seriesUIDs.map(seriesInstanceUID =>
          this.retrieveSeriesMetadata({
            studyInstanceUID,
            seriesInstanceUID,
          })
        )
      );

      return seriesMetadata.flat();
    }

    async retrieveSeriesMetadata({ studyInstanceUID, seriesInstanceUID } = {}) {
      const images = await getSeriesImages(studyInstanceUID, seriesInstanceUID);
      if (!images.length) {
        return [];
      }

      const concurrency = Number(config.metadataRequestConcurrency) || DEFAULT_METADATA_CONCURRENCY;

      return mapWithConcurrency(images, concurrency, imageRecord =>
        getInstanceMetadata(studyInstanceUID, seriesInstanceUID, imageRecord)
      );
    }
  }

  const qidoClient = new CompanyApiClient();
  const wadoClient = new CompanyApiClient();

  const implementation = {
    initialize: ({ params, query }) => {
      runtimeContext = {
        params,
        query,
      };

      if (typeof config.onConfiguration === 'function') {
        config = config.onConfiguration(config, {
          params,
          query,
        });
      }
    },
    query: {
      studies: {
        mapParams: params => params,
        search: async params => {
          qidoClient.headers = buildHeaders();

          if (!params?.studyInstanceUid && !params?.studyInstanceUID) {
            return [];
          }

          const results = await qidoClient.searchForStudies({
            studyInstanceUid: params.studyInstanceUid || params.studyInstanceUID,
          });

          return processResults(results);
        },
        processResults: processResults.bind(),
      },
      series: {
        search: async studyInstanceUid => {
          qidoClient.headers = buildHeaders();
          const results = await qidoClient.searchForSeries({
            studyInstanceUID: studyInstanceUid,
          });

          return processSeriesResults(results);
        },
      },
      instances: {
        search: async (studyInstanceUid, queryParameters = {}) => {
          qidoClient.headers = buildHeaders();
          const seriesInstanceUID =
            queryParameters.SeriesInstanceUID || queryParameters.seriesInstanceUID;

          if (!studyInstanceUid || !seriesInstanceUID) {
            return [];
          }

          return qidoClient.retrieveSeriesMetadata({
            studyInstanceUID: studyInstanceUid,
            seriesInstanceUID,
          });
        },
      },
    },
    retrieve: {
      getGetThumbnailSrc: instance => {
        return () => buildThumbnailUrl(instance);
      },
      series: {
        metadata: async ({
          StudyInstanceUID,
          filters,
          sortCriteria,
          sortFunction,
          madeInClient = false,
          returnPromises = false,
        } = {}) => {
          if (!StudyInstanceUID) {
            throw new Error('Unable to query for SeriesMetadata without StudyInstanceUID');
          }

          if (config.enableStudyLazyLoad !== false) {
            return implementation._retrieveSeriesMetadataAsync(
              StudyInstanceUID,
              filters,
              sortCriteria,
              sortFunction,
              madeInClient,
              returnPromises
            );
          }

          return implementation._retrieveSeriesMetadataSync(
            StudyInstanceUID,
            filters,
            sortCriteria,
            sortFunction,
            madeInClient
          );
        },
      },
    },
    _retrieveSeriesMetadataSync: async (
      StudyInstanceUID,
      filters,
      sortCriteria,
      sortFunction,
      madeInClient
    ) => {
      const data = await retrieveStudyMetadata(
        wadoClient,
        StudyInstanceUID,
        false,
        filters,
        sortCriteria,
        sortFunction,
        config
      );

      const naturalizedInstancesMetadata = data.map(naturalizeDataset);
      const seriesSummaryMetadata = {};
      const instancesPerSeries = {};

      naturalizedInstancesMetadata.forEach(instance => {
        if (!seriesSummaryMetadata[instance.SeriesInstanceUID]) {
          seriesSummaryMetadata[instance.SeriesInstanceUID] = {
            StudyInstanceUID: instance.StudyInstanceUID,
            StudyDescription: instance.StudyDescription,
            SeriesInstanceUID: instance.SeriesInstanceUID,
            SeriesDescription: instance.SeriesDescription,
            SeriesNumber: instance.SeriesNumber,
            SeriesTime: instance.SeriesTime,
            SOPClassUID: instance.SOPClassUID,
            ProtocolName: instance.ProtocolName,
            Modality: instance.Modality,
          };
        }

        if (!instancesPerSeries[instance.SeriesInstanceUID]) {
          instancesPerSeries[instance.SeriesInstanceUID] = [];
        }

        const imageId = implementation.getImageIdsForInstance({ instance });
        instance.imageId = imageId;
        instance.wadoUri = buildDicomFileUrl(instance);

        metadataProvider.addImageIdToUIDs(imageId, {
          StudyInstanceUID,
          SeriesInstanceUID: instance.SeriesInstanceUID,
          SOPInstanceUID: instance.SOPInstanceUID,
        });

        instancesPerSeries[instance.SeriesInstanceUID].push(instance);
      });

      const seriesMetadata = Object.values(seriesSummaryMetadata);
      DicomMetadataStore.addSeriesMetadata(seriesMetadata, madeInClient);

      Object.keys(instancesPerSeries).forEach(seriesInstanceUID =>
        DicomMetadataStore.addInstances(instancesPerSeries[seriesInstanceUID], madeInClient)
      );

      return seriesSummaryMetadata;
    },
    _retrieveSeriesMetadataAsync: async (
      StudyInstanceUID,
      filters,
      sortCriteria,
      sortFunction,
      madeInClient = false,
      returnPromises = false
    ) => {
      const requestedSeriesUIDs = normalizeUIDList(
        filters?.seriesInstanceUID || filters?.SeriesInstanceUID
      );
      const { seriesSummaryMetadata: allSeriesSummaryMetadata } =
        await createLazySeriesLoadPlan(StudyInstanceUID);

      const filteredSeries =
        requestedSeriesUIDs.length > 0
          ? allSeriesSummaryMetadata.reduce(
              (acc, metadata) => {
                if (requestedSeriesUIDs.includes(metadata.SeriesInstanceUID)) {
                  acc.seriesSummaryMetadata.push(metadata);
                }
                return acc;
              },
              {
                seriesSummaryMetadata: [],
              }
            )
          : {
              seriesSummaryMetadata: allSeriesSummaryMetadata,
            };

      const { seriesSummaryMetadata } = filteredSeries;

      function storeInstances(instances) {
        const naturalizedInstances = instances.map(naturalizeDataset);

        naturalizedInstances.forEach(instance => {
          instance.wadoUri = buildDicomFileUrl(instance);

          const { StudyInstanceUID, SeriesInstanceUID, SOPInstanceUID } = instance;
          const numberOfFrames = Number(instance.NumberOfFrames || 1);

          for (let i = 0; i < numberOfFrames; i++) {
            const frameNumber = i + 1;
            const frameImageId = implementation.getImageIdsForInstance({
              instance,
              frame: frameNumber,
            });

            metadataProvider.addImageIdToUIDs(frameImageId, {
              StudyInstanceUID,
              SeriesInstanceUID,
              SOPInstanceUID,
              frameNumber: numberOfFrames > 1 ? frameNumber : undefined,
            });
          }

          instance.imageId = implementation.getImageIdsForInstance({ instance });
        });

        DicomMetadataStore.addInstances(naturalizedInstances, madeInClient);

        const firstInstance = naturalizedInstances[0];
        if (firstInstance) {
          const series = DicomMetadataStore.getSeries(
            firstInstance.StudyInstanceUID,
            firstInstance.SeriesInstanceUID
          );

          DicomMetadataStore.updateSeriesMetadata({
            StudyInstanceUID: firstInstance.StudyInstanceUID,
            SeriesInstanceUID: firstInstance.SeriesInstanceUID,
            Modality: firstInstance.Modality,
            SeriesNumber: firstInstance.SeriesNumber,
            SeriesDate: firstInstance.SeriesDate,
            SeriesDescription: firstInstance.SeriesDescription,
            NumberOfSeriesRelatedInstances:
              series?.instances?.length || naturalizedInstances.length,
            StudyDescription: firstInstance.StudyDescription,
            StudyID: firstInstance.StudyID,
          });
        }
      }

      function setSuccessFlag() {
        const study = DicomMetadataStore.getStudy(StudyInstanceUID);
        if (study) {
          study.isLoaded = true;
        }
      }

      seriesSummaryMetadata.forEach(series => {
        series.StudyInstanceUID = StudyInstanceUID;
      });

      DicomMetadataStore.addSeriesMetadata(seriesSummaryMetadata, madeInClient);

      if (!seriesSummaryMetadata.length) {
        setSuccessFlag();
        return seriesSummaryMetadata;
      }

      const backgroundSeriesPromises = new Map();
      let hasAttachedStudyCompletionListener = false;

      const attachStudyCompletionListener = () => {
        if (
          hasAttachedStudyCompletionListener ||
          backgroundSeriesPromises.size !== seriesSummaryMetadata.length
        ) {
          return;
        }

        hasAttachedStudyCompletionListener = true;

        Promise.allSettled(Array.from(backgroundSeriesPromises.values())).then(() =>
          setSuccessFlag()
        );
      };

      const loadSeriesProgressively = async (seriesMetadata, seriesPromise) => {
        const { SeriesInstanceUID: seriesInstanceUID } = seriesMetadata;
        const images = sortImageRecords(await getSeriesImages(StudyInstanceUID, seriesInstanceUID));

        if (!images.length) {
          seriesPromise.completionPromise = Promise.resolve([]);
          backgroundSeriesPromises.set(seriesInstanceUID, seriesPromise.completionPromise);
          attachStudyCompletionListener();
          return [];
        }

        const [firstImageRecord, ...remainingImageRecords] = images;
        const firstInstance = await getInstanceMetadata(
          StudyInstanceUID,
          seriesInstanceUID,
          firstImageRecord
        );

        storeInstances([firstInstance]);

        seriesPromise.completionPromise = (async () => {
          const loadedInstances = [];

          for (const imageRecord of remainingImageRecords) {
            const instance = await getInstanceMetadata(
              StudyInstanceUID,
              seriesInstanceUID,
              imageRecord
            );
            loadedInstances.push(instance);
            storeInstances([instance]);
          }

          return loadedInstances;
        })();

        backgroundSeriesPromises.set(seriesInstanceUID, seriesPromise.completionPromise);
        attachStudyCompletionListener();

        return [firstInstance];
      };

      const seriesPromises = seriesSummaryMetadata.map(seriesMetadata => {
        const seriesPromise = new DeferredSeriesPromise(seriesMetadata, () =>
          loadSeriesProgressively(seriesMetadata, seriesPromise)
        );

        return seriesPromise;
      });

      if (returnPromises) {
        return seriesPromises;
      }

      await Promise.all(seriesPromises.map(seriesPromise => seriesPromise.start()));
      attachStudyCompletionListener();

      return seriesSummaryMetadata;
    },
    deleteStudyMetadataPromise,
    getImageIdsForDisplaySet(displaySet) {
      const imageIds = [];
      const images = displaySet.images || [];

      images.forEach(instance => {
        const numberOfFrames = Number(instance.NumberOfFrames || 1);

        if (numberOfFrames > 1) {
          for (let frame = 1; frame <= numberOfFrames; frame++) {
            imageIds.push(
              implementation.getImageIdsForInstance({
                instance,
                frame,
              })
            );
          }
        } else {
          imageIds.push(
            implementation.getImageIdsForInstance({
              instance,
            })
          );
        }
      });

      return imageIds;
    },
    getImageIdsForInstance({ instance, frame = undefined }) {
      return buildImageId({ instance, frame });
    },
    getConfig() {
      return {
        ...config,
        apiRoot: getApiRoot(),
      };
    },
    getStudyInstanceUIDs({ params, query }) {
      const paramsStudyInstanceUIDs =
        params.StudyInstanceUIDs || params.studyInstanceUIDs || params.studyuid;
      const queryStudyInstanceUIDs = utils.splitComma(
        query
          .getAll('StudyInstanceUIDs')
          .concat(query.getAll('studyInstanceUIDs'))
          .concat(query.getAll('studyuid'))
      );

      const StudyInstanceUIDs =
        (queryStudyInstanceUIDs.length && queryStudyInstanceUIDs) || paramsStudyInstanceUIDs;

      if (!StudyInstanceUIDs) {
        return [];
      }

      return Array.isArray(StudyInstanceUIDs) ? StudyInstanceUIDs : [StudyInstanceUIDs];
    },
  };

  return IWebApiDataSource.create(implementation);
}

export { createCompanyApi };
