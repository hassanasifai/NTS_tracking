from fastapi import FastAPI, WebSocket, Query, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
import psycopg
from psycopg.rows import dict_row
import geojson
from dotenv import load_dotenv
import os
import asyncio
from datetime import datetime, timedelta
import time
from typing import List, Dict, Optional
import json

# Load environment variables
load_dotenv()

# Initialize FastAPI app
app = FastAPI(title="Truck Tracker API")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, replace with actual frontend URL
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Database connection parameters
db_params = {
    "host": os.getenv("DB_HOST"),
    "port": os.getenv("DB_PORT"),
    "dbname": os.getenv("DB_NAME"),
    "user": os.getenv("DB_USER"),
    "password": os.getenv("DB_PASSWORD"),
}

# Constants
STALE_THRESHOLD_HOURS = 1  # Vehicles with data older than this are considered stopped
IDLE_THRESHOLD_HOURS = 0.5  # Vehicles with data older than this but newer than STALE are considered idle

# Connect to PostgreSQL database
async def get_db_connection():
    try:
        conn = await psycopg.AsyncConnection.connect(
            **db_params, 
            row_factory=dict_row
        )
        return conn
    except Exception as e:
        print(f"Error connecting to database: {e}")
        raise HTTPException(status_code=500, detail=f"Database connection error: {str(e)}")

# Function to determine vehicle status based on timestamp
def determine_status(timestamp):
    current_time = int(time.time())
    time_diff_hours = (current_time - timestamp) / 3600
    
    if time_diff_hours > STALE_THRESHOLD_HOURS:
        return 'stopped'
    elif time_diff_hours > IDLE_THRESHOLD_HOURS:
        return 'idle'
    else:
        return 'moving'

# Get all vehicles with their latest locations
async def get_truck_locations(
    car_filter: Optional[str] = None, 
    date_from: Optional[str] = None,
    date_to: Optional[str] = None
):
    try:
        conn = await get_db_connection()
        async with conn:
            async with conn.cursor() as cur:
                # Base query to get latest location for each vehicle
                query = """
                WITH latest_records AS (
                    SELECT DISTINCT ON (car) 
                        car, 
                        latitude, 
                        longitude, 
                        "timestamp",
                        date
                    FROM 
                        public.tracking_data2
                    WHERE 
                        1=1
                """
                
                params = []
                
                # Add filters if provided
                if car_filter:
                    # Handle CSV format for multiple vehicle IDs
                    if ',' in car_filter:
                        vehicle_ids = [vid.strip() for vid in car_filter.split(',') if vid.strip()]
                        if vehicle_ids:
                            placeholders = ', '.join(['%s'] * len(vehicle_ids))
                            query += f" AND car IN ({placeholders})"
                            params.extend(vehicle_ids)
                    else:
                        # Exact match for single vehicle
                        query += " AND car = %s"
                        params.append(car_filter)
                
                if date_from:
                    query += " AND date >= %s"
                    params.append(date_from)
                
                if date_to:
                    query += " AND date <= %s"
                    params.append(date_to)
                
                # Complete the query with ordering
                query += """ 
                    ORDER BY 
                        car, 
                        "timestamp" DESC
                )
                SELECT * FROM latest_records
                """
                
                await cur.execute(query, params)
                rows = await cur.fetchall()
                
                features = []
                for row in rows:
                    # Determine status based on timestamp
                    status = determine_status(row['timestamp'])
                    
                    features.append({
                        "type": "Feature",
                        "geometry": {
                            "type": "Point",
                            "coordinates": [
                                float(row['longitude']),
                                float(row['latitude'])
                            ]
                        },
                        "properties": {
                            "id": row['car'],
                            "status": status,
                            "timestamp": row['timestamp'],
                            "date": str(row['date']),
                            "last_update": datetime.fromtimestamp(row['timestamp']).strftime('%Y-%m-%d %H:%M:%S')
                        }
                    })
                
                return features
    except Exception as e:
        print(f"Error getting truck locations: {e}")
        return []

@app.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    car_filter: str = None,
    date_from: str = None,
    date_to: str = None
):
    await websocket.accept()
    try:
        while True:
            try:
                # Handle incoming filters from client
                data = None
                try:
                    data = await asyncio.wait_for(websocket.receive_json(), timeout=0.01)
                    if data and 'filters' in data:
                        filters = data['filters']
                        car_filter = filters.get('car', car_filter)
                        date_from = filters.get('dateFrom', date_from)
                        date_to = filters.get('dateTo', date_to)
                        print(f"Received filters: vehicle={car_filter}, from={date_from}, to={date_to}")
                except asyncio.TimeoutError:
                    pass
                except Exception as e:
                    print(f"Error processing client message: {e}")
                
                # Get truck locations with applied filters
                features = await get_truck_locations(car_filter, date_from, date_to)
                
                # Count vehicles by status
                status_counts = {'moving': 0, 'idle': 0, 'stopped': 0}
                for feature in features:
                    status = feature['properties']['status']
                    status_counts[status] += 1
                
                # Debug info
                print(f"Sending {len(features)} features to client")
                print(f"Status counts: {status_counts}")
                
                # Send data to client
                await websocket.send_json({
                    "type": "FeatureCollection",
                    "features": features,
                    "counts": status_counts
                })
                
                await asyncio.sleep(5)
            except Exception as e:
                print(f"Error in WebSocket loop: {e}")
                break
    finally:
        await websocket.close()

# RESTful API endpoints
@app.get("/")
async def root():
    return {"message": "Truck Tracker API is running"}

@app.get("/api/trucks")
async def get_trucks(
    car: Optional[str] = Query(None, description="Filter by car number/name"),
    date_from: Optional[str] = Query(None, description="Filter from date (YYYY-MM-DD)"),
    date_to: Optional[str] = Query(None, description="Filter to date (YYYY-MM-DD)")
):
    features = await get_truck_locations(car, date_from, date_to)
    return {
        "type": "FeatureCollection",
        "features": features
    }

@app.get("/api/vehicles")
async def get_all_vehicles():
    """Get a list of all vehicle IDs in the database"""
    try:
        print("Fetching all vehicle IDs...")
        conn = await get_db_connection()
        async with conn:
            async with conn.cursor() as cur:
                query = """
                SELECT DISTINCT car 
                FROM public.tracking_data2 
                ORDER BY car
                """
                
                await cur.execute(query)
                rows = await cur.fetchall()
                
                # Extract vehicle IDs into a simple list
                vehicles = [row['car'] for row in rows]
                
                print(f"Found {len(vehicles)} vehicles: {vehicles[:5]}..." if len(vehicles) > 5 else f"Found {len(vehicles)} vehicles: {vehicles}")
                
                return {"vehicles": vehicles}
    except Exception as e:
        print(f"Error fetching vehicles: {e}")
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

@app.get("/api/trucks/{car_id}")
async def get_truck_history(
    car_id: str,
    date_from: Optional[str] = Query(None, description="Filter from date (YYYY-MM-DD)"),
    date_to: Optional[str] = Query(None, description="Filter to date (YYYY-MM-DD)")
):
    try:
        conn = await get_db_connection()
        async with conn:
            async with conn.cursor() as cur:
                query = """
                SELECT 
                    car, 
                    latitude, 
                    longitude, 
                    "timestamp",
                    date
                FROM 
                    public.tracking_data2
                WHERE 
                    car = %s
                """
                
                params = [car_id]
                
                if date_from:
                    query += " AND date >= %s"
                    params.append(date_from)
                
                if date_to:
                    query += " AND date <= %s"
                    params.append(date_to)
                
                query += " ORDER BY \"timestamp\" DESC LIMIT 100"
                
                await cur.execute(query, params)
                rows = await cur.fetchall()
                
                features = []
                for row in rows:
                    # Determine status based on timestamp
                    status = determine_status(row['timestamp'])
                    
                    features.append({
                        "type": "Feature",
                        "geometry": {
                            "type": "Point",
                            "coordinates": [
                                float(row['longitude']),
                                float(row['latitude'])
                            ]
                        },
                        "properties": {
                            "id": row['car'],
                            "status": status,
                            "timestamp": row['timestamp'],
                            "date": str(row['date']),
                            "last_update": datetime.fromtimestamp(row['timestamp']).strftime('%Y-%m-%d %H:%M:%S')
                        }
                    })
                
                return {
                    "type": "FeatureCollection",
                    "features": features
                }
    except Exception as e:
        print(f"Error getting truck history: {e}")
        raise HTTPException(status_code=500, detail=f"Error fetching truck history: {str(e)}")
