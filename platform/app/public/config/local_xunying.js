/** @type {AppTypes.Config} */

window.config = {
  name: 'config/local_xunying.js',
  routerBasename: null,
  extensions: [],
  modes: [],
  showStudyList: false,
  showLoadingIndicator: true,
  showWarningMessageForCrossOrigin: true,
  showCPUFallbackMessage: true,
  strictZSpacingForVolumeViewport: true,
  maxNumberOfWebWorkers: 3,
  groupEnabledModesFirst: true,
  showErrorDetails: 'always',
  defaultDataSourceName: 'ohif',
  redirectRootTo:
    '/viewer?hospital=lyxytjzx&studyuid=2604281231850&token=eyJ0eXBlIjoiYmFzaWMgYXV0aCIsInN0dWR5dWlkIjpbIjI2MDQyODEyMzE4NTAiXX0.HNHx1g.Zg02B7WBN787klTJ7prRt6Y0EOs',
  dataSources: [
    {
      namespace: '@ohif/extension-default.dataSourcesModule.companyapi',
      sourceName: 'ohif',
      configuration: {
        friendlyName: 'Company PACS API',
        name: 'companyapi',
        apiRoot: '/webpacs/api',
        tokenHeaderName: 'token',
        tokenQueryParam: 'token',
        hospitalQueryParam: 'hospital',
        imageRendering: 'wadouri',
        enableStudyLazyLoad: true,
        metadataRequestConcurrency: 4,
        thumbnailRows: 256,
        thumbnailColumns: 256,
        thumbnailQuality: 60,
      },
    },
  ],
  httpErrorHandler: error => {
    console.warn(error.status);
    console.warn('Local xunying debug request failed.');
  },
};
