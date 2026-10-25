#!/usr/bin/env python3
"""OSM PBFから限定地域のStepBy点字ブロックz15 seedを生成する。

このスクリプトはOSMへ接続・書込みを行わない。公式配布PBFと、事前に保存した
行政境界GeoJSONをローカルで読み、`import_local_tactile_tiles.js`用JSONを作る。
"""

import argparse
import json
import math
import os
from collections import Counter
from datetime import datetime, timezone

import osmium
from shapely.geometry import LineString, Point, box, shape


ZOOM = 15
STEPBY_VALUES = {"yes", "both", "contrasted"}


def lon_to_x(lon):
    return int(math.floor((lon + 180.0) / 360.0 * (2 ** ZOOM)))


def lat_to_y(lat):
    radians = math.radians(lat)
    return int(math.floor((1.0 - math.asinh(math.tan(radians)) / math.pi) / 2.0 * (2 ** ZOOM)))


def tile_bounds(x, y):
    scale = 2 ** ZOOM
    west = x / scale * 360.0 - 180.0
    east = (x + 1) / scale * 360.0 - 180.0
    north = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / scale))))
    south = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / scale))))
    return west, south, east, north


def feature_properties(osm_type, osm_id, tags, changeset, version):
    tag_dict = dict(tags)
    positive_changeset = int(changeset) if changeset and int(changeset) > 0 else None
    return {
        "osm_type": osm_type,
        "osm_id": int(osm_id),
        "osm_way_id": int(osm_id) if osm_type == "way" else None,
        "osm_node_id": int(osm_id) if osm_type == "node" else None,
        "matched_tag_key": "tactile_paving",
        "matched_tag_value": tag_dict.get("tactile_paving"),
        "osm_changeset_id": positive_changeset,
        "osm_version": int(version) if version else None,
        "stepby_recorded": any(
            "stepby" in str(key).lower() or "stepby" in str(value).lower()
            for key, value in tag_dict.items()
        ),
    }


class TactileHandler(osmium.SimpleHandler):
    def __init__(self, boundary):
        super().__init__()
        self.boundary = boundary
        self.features = []
        self.tag_counts = Counter()

    def node(self, node):
        value = node.tags.get("tactile_paving")
        if value not in STEPBY_VALUES:
            return
        point = Point(node.location.lon, node.location.lat)
        if not self.boundary.covers(point):
            return
        self.tag_counts[f"node:{value}"] += 1
        self.features.append({
            "type": "Feature",
            "properties": feature_properties(
                "node", node.id, node.tags, node.changeset, node.version
            ),
            "geometry": {
                "type": "Point",
                "coordinates": [node.location.lon, node.location.lat],
            },
        })

    def way(self, way):
        value = way.tags.get("tactile_paving")
        if value not in STEPBY_VALUES:
            return
        coordinates = [
            [node.location.lon, node.location.lat]
            for node in way.nodes if node.location.valid()
        ]
        if len(coordinates) < 2:
            return
        line = LineString(coordinates)
        if not self.boundary.intersects(line):
            return
        self.tag_counts[f"way:{value}"] += 1
        self.features.append({
            "type": "Feature",
            "properties": feature_properties(
                "way", way.id, way.tags, way.changeset, way.version
            ),
            "geometry": {"type": "LineString", "coordinates": coordinates},
        })


def load_boundary(path):
    with open(path, encoding="utf-8") as source:
        collection = json.load(source)
    features = collection.get("features") if isinstance(collection, dict) else None
    if not isinstance(features, list) or len(features) != 1:
        raise ValueError("boundary_geojson_must_have_exactly_one_feature")
    result = shape(features[0]["geometry"])
    if result.is_empty or not result.is_valid:
        raise ValueError("invalid_boundary_geometry")
    return result


def build_tiles(boundary, features):
    feature_geometries = [(feature, shape(feature["geometry"])) for feature in features]
    min_lon, min_lat, max_lon, max_lat = boundary.bounds
    min_x, max_x = lon_to_x(min_lon), lon_to_x(max_lon)
    min_y, max_y = lat_to_y(max_lat), lat_to_y(min_lat)
    tiles = []
    for x in range(min_x, max_x + 1):
        for y in range(min_y, max_y + 1):
            west, south, east, north = tile_bounds(x, y)
            tile_polygon = box(west, south, east, north)
            if not boundary.intersects(tile_polygon):
                continue
            tile_features = [
                feature for feature, geometry in feature_geometries
                if geometry.intersects(tile_polygon)
            ]
            tiles.append({
                "tileId": f"{ZOOM}/{x}/{y}",
                "zoom": ZOOM,
                "tileX": x,
                "tileY": y,
                "status": "success" if tile_features else "empty",
                "features": tile_features,
            })
    return tiles


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pbf", required=True, help="Geofabrik等から取得したOSM PBF")
    parser.add_argument("--boundary", required=True, help="対象地域を1 Featureで表すGeoJSON")
    parser.add_argument("--output", required=True, help="生成するseed JSON")
    parser.add_argument("--region", required=True, help="例: 岡山市")
    parser.add_argument("--source-url", required=True, help="PBFの取得元HTTPS URL")
    parser.add_argument("--snapshot-id", help="省略時はUTC日付から生成")
    args = parser.parse_args()

    if not args.source_url.startswith("https://"):
        raise ValueError("source_url_must_be_https")
    boundary = load_boundary(args.boundary)
    handler = TactileHandler(boundary)
    handler.apply_file(args.pbf, locations=True)
    tiles = build_tiles(boundary, handler.features)
    if not tiles or len(tiles) > 5000:
        raise ValueError("generated_tile_count_out_of_range")

    now = datetime.now(timezone.utc)
    snapshot_id = args.snapshot_id or f"geofabrik-chugoku-{now.strftime('%Y%m%d')}"
    bundle = {
        "formatVersion": 1,
        "snapshotId": snapshot_id,
        "generatedAt": now.isoformat(),
        "sourceUrl": args.source_url,
        "licence": "OpenStreetMap contributors, ODbL 1.0",
        "region": args.region,
        "zoom": ZOOM,
        "tiles": tiles,
    }
    with open(args.output, "w", encoding="utf-8") as output:
        json.dump(bundle, output, ensure_ascii=False, separators=(",", ":"))

    print(json.dumps({
        "snapshotId": snapshot_id,
        "tagCounts": dict(sorted(handler.tag_counts.items())),
        "uniqueFeatures": len(handler.features),
        "tiles": len(tiles),
        "readyTiles": sum(1 for tile in tiles if tile["status"] == "success"),
        "emptyTiles": sum(1 for tile in tiles if tile["status"] == "empty"),
        "featureCopies": sum(len(tile["features"]) for tile in tiles),
        "bytes": os.path.getsize(args.output),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
