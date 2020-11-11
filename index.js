/**
 * TODOs:
 * - define schemas for fastify.multipart (?)
 * - improve/add some logging
 * - tests
 */

const util = require('util');

const fs = require('fs');
const mkdir = util.promisify(fs.mkdir);
const stat = util.promisify(fs.stat);
const unlink = util.promisify(fs.unlink);
const copyFile = util.promisify(fs.copyFile);

const { pipeline } = require('stream');
const pump = util.promisify(pipeline);

const fastifyMultipart = require('fastify-multipart');

// const createError = require('fastify-error');
// const SomeError = createError('FST_GFIERR001', 'Unable to \'%s\' of %s');

const { download: downloadSchema, upload: uploadSchema } = require('./schemas/shared');

const ITEM_TYPE = 'file';
const ORIGINAL_FILENAME_TRUNCATE_LIMIT = 100;
const DEFAULT_MAX_FILE_SIZE = 10424 * 1024 * 250; // 250MB

const randomHexOf4 = () => (Math.random() * (1 << 16) | 0).toString(16).padStart(4, '0');

module.exports = async (fastify, options) => {
  // TODO: throw error if 'storageRootPath' is not supplied???
  const { storageRootPath } = options;

  if (!storageRootPath) throw new Error('graasp-file-item: missing plugin option `storageRootPath`');

  const { taskManager } = fastify;

  // register post delete handler to erase the file of a 'file item'
  taskManager.setPostDeleteHandler((item, actor, log) => {
    const { type: itemType, extra: { path: filepath } } = item;
    if (itemType !== ITEM_TYPE) return;

    const storageFilepath = `${storageRootPath}/${filepath}`;
    unlink(storageFilepath)
      // using request's logger instance. can't use arrow fn because 'log.error' uses 'this'.
      .catch(function (error) { log.error(error) });
  });

  // register pre copy handler to make a copy of the 'file item's file
  taskManager.setPreCopyHandler(async function (item) {
    const { type: itemType, extra: { path: originalFilepath } } = item;
    if (itemType !== ITEM_TYPE) return;

    const path = `${randomHexOf4()}/${randomHexOf4()}`;

    // create directories path
    await mkdir(`${storageRootPath}/${path}`, { recursive: true });

    // copy file
    const filepath = `${path}/${randomHexOf4()}-${Date.now()}`;
    const storageFilepath = `${storageRootPath}/${filepath}`;

    const storageOriginalFilepath = `${storageRootPath}/${originalFilepath}`;
    await copyFile(storageOriginalFilepath, storageFilepath);

    // update item copy's 'extra' 
    item.extra.path = filepath;
  });


  fastify.register(fastifyMultipart, {
    limits: {
      // fieldNameSize: 0,             // Max field name size in bytes (Default: 100 bytes).
      // fieldSize: 1000000,           // Max field value size in bytes (Default: 1MB).
      fields: 0,                       // Max number of non-file fields (Default: Infinity).
      fileSize: DEFAULT_MAX_FILE_SIZE, // For multipart forms, the max file size (Default: Infinity).
      files: 5,                        // Max number of file fields (Default: Infinity).
      // headerPairs: 2000             // Max number of header key=>value pairs (Default: 2000 - same as node's http).
    }
  });

  // receive uploaded file(s) and create item(s)
  fastify.post('/upload', { schema: uploadSchema }, async (request, reply) => {
    const { query: { parentId }, member, log } = request;
    const parts = await request.files();

    for await (const { file, filename, mimetype, encoding } of parts) {
      const path = `${randomHexOf4()}/${randomHexOf4()}`;

      // create directories path
      await mkdir(`${storageRootPath}/${path}`, { recursive: true });

      // 'pump' file to directory
      const filepath = `${path}/${randomHexOf4()}-${Date.now()}`;
      const storageFilepath = `${storageRootPath}/${filepath}`;
      await pump(file, fs.createWriteStream(storageFilepath));

      // get file size 
      const { size } = await stat(storageFilepath);

      try {
        // create 'file' item
        const name = filename.substring(0, ORIGINAL_FILENAME_TRUNCATE_LIMIT);
        const item = {
          name,
          type: ITEM_TYPE,
          extra: { name: filename, path: filepath, size, mimetype, encoding }
        };
        const task = taskManager.createCreateTask(member, item, parentId);
        await taskManager.run([task], log);
      } catch (error) {
        await unlink(storageFilepath); // delete file if creation fails
        throw error;
      }
    }

    reply.status(204);
  });

  // download item's file
  fastify.get('/:id/download', { schema: downloadSchema }, async (request, reply) => {
    const { member, params: { id }, log } = request;

    const task = taskManager.createGetTask(member, id);
    const { type, extra: { name, path, mimetype } } = await taskManager.run([task], log);

    if (type !== ITEM_TYPE || !path || !name) {
      reply.status(400);
      throw new Error(`Invalid '${ITEM_TYPE}' item`);
    }

    reply.type(mimetype);
    // this header will make the browser download the file with 'name' instead of
    // simply opening it and showing it
    reply.header('Content-Disposition', `attachment; filename="${name}"`);

    // TODO: can/should this be done in a worker (fastify piscina)?
    return fs.createReadStream(`${storageRootPath}/${path}`);
  });
};
