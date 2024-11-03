import requests

# Fetch player stats from the Torn API they give
def fetch_player_stats(player_id, api_key):
    url = f"https://api.ton.com/user/{player_id}?selections=battlestats&key={api_key}"
    response = requests.get(url)
    if response.status_code == 200:
        data = response.json()
        stats = data.get("strength"), data.get("defense"), data.get("speed"), data.get("dexterity")
        return stats
    else:
        print(f"Failed to fetch data for player {player_id}. Status Code: {response.status_code}")
        return None