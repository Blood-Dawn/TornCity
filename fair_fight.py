from data_loader import load_targets
import math

# Function to calculate the battle Score of a player from their stats
def battle_score(stats):
    return math.sqrt(stats["strength"]) + math.sqrt(stats["defense"]) + math.sqrt(stats["speed"]) + math.sqrt(stats["dexterity"])

# Function to check if a target is within Fair Fight range
def ff_multiplier(user_score, target_score):
    return 1 + (8/3) * (target_score / user_score)

# Determine the difficulty level of a target
def get_difficulty(multiplier):
    if multiplier < 1.9:
        return "easy"
    elif  2 <= multiplier < 3:
        return "medium"
    elif 3 <= multiplier <= 4.5:
        return "hard"
    else:
        return "impossible"
    
# Check if a target is within Fair Fight range
def is_fair_fight(user_id, target_id, api_key):
    # Load the target data
    targets = load_targets()
    
    # Fetch the stats of the user and the target
    user_stats = fetch_player_stats(user_id, api_key)
    target_stats = fetch_player_stats(target_id, api_key)
    
    # Calculate the battle score of the user and the target
    user_score = battle_score(user_stats)
    target_score = battle_score(target_stats)
    
    # Calculate the Fair Fight multiplier
    multiplier = ff_multiplier(user_score, target_score)
    
    # Determine the difficulty level of the target
    difficulty = get_difficulty(multiplier)
    
    # Check if the target is within Fair Fight range
    if difficulty == "impossible":
        return False, f"Target is impossible to beat with a multiplier of {multiplier}"
    else:
        return True, f"Target is within Fair Fight range with a multiplier of {multiplier} and difficulty level {difficulty}"