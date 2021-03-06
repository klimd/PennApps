var queue = require('queue-async');
var extent = require('geojson-extent');
var through = require('through2');
var SphericalMercator = require('sphericalmercator');
var merc = new SphericalMercator();
var _ = require('lodash');

module.exports = Metadata;

function Metadata(dyno, dataset) {

    /**
     * A client for interacting with the metadata for a dataset
     * @private
     */
    var metadata = {};
    var recordId = metadata.recordId = 'metadata!' + dataset;
    var key = metadata.key = { id: recordId, dataset: dataset };

    /**
     * Helper routine for performing conditional updates. Ignores ConditionalCheckFailedExceptions, but returns true/false to indicate whether an update was performed
     * @private
     * @param {object} item - a dyno object
     * @param {object} opts - an object defining the conditional expression
     * @param {function} cb - a callback function to handle the response
     */
    function conditionalUpdate(item, opts, cb) {
        dyno.updateItem(key, item, opts, function(err) {
            if (err && err.code === 'ConditionalCheckFailedException')
                return cb(null, false);
            else if (err)
                return cb(err, false);
            cb(null, true);
        });
    }

    /**
     * Return dataset metadata or an empty object
     * @private
     * @param {function} callback - a callback function to handle the response
     */
    metadata.getInfo = function(callback) {
        dyno.getItem(key, function(err, item) {
            if (err) return callback(err);
            callback(null, item ? prepare(item) : {});
        });
    };

    /**
     * Return the details for a given GeoJSON feature
     * @private
     * @param {object} feature - a GeoJSON feature
     * @returns {object} an object describing the feature's size and extent
     */
    metadata.getFeatureInfo = function(feature) {
        var bounds = extent(feature);
        return {
            size: Buffer.byteLength(JSON.stringify(feature)),
            bounds: bounds,
            west: bounds[0],
            south: bounds[1],
            east: bounds[2],
            north: bounds[3]
        };
    };

    /**
     * Create and stores a metadata record with default values if no record exists. Returns true/false to indicate whether a record was created.
     * @private
     * @param {function} callback - a function to handle the response
     */
    metadata.defaultInfo = function(callback) {
        var info = {};
        info.put = {
            west: 180,
            south: 90,
            east: -180,
            north: -90,
            count: 0,
            size: 0,
            updated: +new Date()
        };

        var opts = { expected: {} };
        opts.expected.id = { NULL: [] };

        conditionalUpdate(info, opts, callback);
    };

    /**
     * Find all features in a dataset and bring metadata record up-to-date
     * @private
     * @param {function} callback - a function to handle the response
     */
    metadata.calculateInfo = function(callback) {
        var info = {
            dataset: dataset,
            id: recordId,
            west: 180,
            south: 90,
            east: -180,
            north: -90,
            count: 0,
            size: 0,
            updated: +new Date()
        };

        var query = { dataset: { EQ: dataset }, id: { BEGINS_WITH: 'id!' } };
        var opts = { pages: 0 };

        dyno.query(query, opts)
            .on('error', callback)
            .pipe(through({ objectMode: true }, function(data, enc, cb) {
                info.count++;
                info.size = info.size + data.size;
                info.west = info.west > data.west ? data.west : info.west;
                info.south = info.south > data.south ? data.south : info.south;
                info.east = info.east < data.east ? data.east : info.east;
                info.north = info.north < data.north ? data.north : info.north;
                cb();
            }))
            .on('error', callback)
            .on('finish', function() {
                dyno.putItem(info, function(err) {
                    callback(err, prepare(info));
                });
            });
    };

    /**
     * Adjust the bounds in an existing metadata record. This operation **will not** create a metadata record if one does not exist.
     * @private
     * @param {number[]} bounds - bounds to add to the existing bounds for the dataset
     * @param {function} callback - a function to handle the response
     */
    metadata.adjustBounds = function(bounds, callback) {
        var q = queue();
        var labels = ['west', 'south', 'east', 'north'];

        bounds.forEach(function(bound, i) {
            var item = { put: {} };
            item.put[labels[i]] = bound;
            item.put.updated = +new Date();

            var opts = { expected: {} };
            opts.expected[labels[i]] =  i < 2 ? {GT: bound } : {LT: bound };
            q.defer(conditionalUpdate, item, opts);
        });

        q.awaitAll(callback);
    };

    /**
     * Increment/decrement the specified properties. This operation **will not** create a metadata record if one does not exist.
     * @private
     * @param {object} properties - an object describing the properties in increase or decrease
     * @param {function} callback - a function to handle the response
     */
    metadata.adjustProperties = function(properties, callback) {
        var item = { add: properties, put: {} };
        item.put.updated = +new Date();

        var opts = { expected: {} };
        opts.expected.id = { NOT_NULL: [] };

        conditionalUpdate(item, opts, callback);
    };

    /**
     * Given a GeoJSON feature, perform all required metadata updates. This operation **will** create a metadata record if one does not exist.
     * @private
     * @param {object} feature - a GeoJSON feature being added to the dataset, or the backend representation of a feature
     * @param {function} callback - a function to handle the response
     */
    metadata.addFeature = function(feature, callback) {
        var info = isDatabaseRecord(feature) ? feature : metadata.getFeatureInfo(feature);

        metadata.defaultInfo(function(err) {
            if (err) return callback(err);

            queue()
                .defer(metadata.adjustProperties, { count: 1, size: info.size })
                .defer(metadata.adjustBounds, [info.west, info.south, info.east, info.north])
                .awaitAll(function(err) {
                    if (err) return callback(err);
                    callback();
                });
        });
    };

    /**
     * Given before and after states of a GeoJSON feature, perform all required metadata adjustments. This operation **will not** create a metadata record if one does not exist.
     * @private
     * @param {object} from - a GeoJSON feature representing the state of the feature *before* the update, or the backend representation of a feature
     * @param {object} to - a GeoJSON feature representing the state of the feature *after* the update, or the backend representation of a feature
     * @param {function} callback - a function to handle the response
     */
    metadata.updateFeature = function(from, to, callback) {
        var fromInfo = isDatabaseRecord(from) ? from : metadata.getFeatureInfo(from);
        var toInfo = isDatabaseRecord(to) ? to : metadata.getFeatureInfo(to);
        var size = toInfo.size - fromInfo.size;

        queue()
            .defer(metadata.adjustProperties, { size: size })
            .defer(metadata.adjustBounds, [toInfo.west, toInfo.south, toInfo.east, toInfo.north])
            .awaitAll(function(err) {
                if (err) return callback(err);
                callback();
            });
    };

    /**
     * Given a GeoJSON feature to remove, perform all required metadata updates. This operation **will not** create a metadata record if one does not exist. This operation **will not** shrink metadata bounds.
     * @private
     * @param {object} feature - a GeoJSON feature to remove from the dataset, or the backend representation of a feature
     * @param {function} callback - a function to handle the response
     */
    metadata.deleteFeature = function(feature, callback) {
        var info = isDatabaseRecord(feature) ? feature : metadata.getFeatureInfo(feature);

        queue()
            .defer(metadata.adjustProperties, { count: -1, size: -info.size })
            .awaitAll(function(err) {
                if (err) return callback(err);
                callback();
            });
    };

    return metadata;
}

/**
 * Adds additional information to return which can be calculated from the metadata object
 *
 * @private
 * @param {object} info - a metadata record from the database
 * @returns {object} same metadata with additional information appended
 */
function prepare(info) {
    var range = zoomRange(info.size, [info.west, info.south, info.east, info.north]);
    var result = _.clone(info);
    result.minzoom = range.min;
    result.maxzoom = range.max;
    return result;
}

/**
 * Calculate an ideal zoom range based on data size and geographic extent.
 * Makes an implicit assumption that the data is evenly distributed geographically
 * - max = zoom level at which a single tile would contain < 1 kilobyte
 * - min = zoom level at which a single tile would contain > 500 kilobytes
 * - never sets max zoom > 22
 *
 * @private
 * @param {number} bytes - the number of bytes
 * @param {Array<number>} extent - the geographic extent in decimal degrees as [west, south, east, north]
 * @returns {object} an object with `min` and `max` properties corresponding to an ideal min and max zoom
 */
function zoomRange(bytes, extent) {
    var maxSize = 500 * 1024;
    var maxzoom = 14;
    for (var z = 22; z >= 0; z--) {
        var bounds = merc.xyz(extent, z, false, 4326);
        var x = (bounds.maxX - bounds.minX) + 1;
        var y = (bounds.maxY - bounds.minY) + 1;
        var tiles = x * y;
        var avgTileSize = bytes / tiles;

        // The idea is that tilesize of ~1000 bytes is usually the most detail
        // needed, and no need to process tiles with higher zoom
        if (avgTileSize < 1000) maxzoom = z;

        // Tiles are getting too large at current z
        if (avgTileSize > maxSize) return { min: z, max: maxzoom };

        // If all the data fits into one tile, it'll fit all the way to z0
        if (tiles === 1 || z === 0) return { min: 0, max: maxzoom };
    }
}

/**
 * Simple duck-type detection of whether or not an object is a database record
 *
 * @private
 * @param {object} obj - the object to test
 * @returns {boolean} whether or not the object is a backend record
 */
function isDatabaseRecord(obj) {
    if (typeof obj !== 'object') return false;

    var schema = {
        dataset: 'string',
        id: 'string',
        cell: 'string',
        size: 'number',
        west: 'number',
        south: 'number',
        east: 'number',
        north: 'number'
    };

    return Object.keys(schema).reduce(function(isDatabaseRecord, key) {
        if (typeof obj[key] !== schema[key]) isDatabaseRecord = false;
        return isDatabaseRecord;
    }, true);
}
