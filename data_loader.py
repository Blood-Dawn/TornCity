import json

# Load target data from JSON file
def load_targets(file_path = "data/baldrs_list.json"):
    try:
        with open(file_path, "r") as file:
            data = json.load(file)
        
        #combine target into single list
        targets = (
            data.get("Baldr's List 1" , []) +
            data.get("Baldr's List 2" , []) +
            data.get("Baldr's List 3" , []) +
            data.get("Baldr's Extra List 1" , []) +
            data.get("Baldr's Extra List 2" , []) +
            data.get("Baldr's Extra List 3" , []) +
            data.get("Baldr's DOMINO List" , []) 
        )
        return targets
    
    except FileNotFoundError:
        print(f"File not found at path: {file_path}")
        return []
    except json.JSONDecodeError:
        print(f"File at path {file_path} is not a valid JSON file")
        return []
    
