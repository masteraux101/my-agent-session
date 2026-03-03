import qsharp
import qsharp.azure

# Initialize the Modern QDK
print("Initializing Q# Modern Runtime...")

# Compile the .qs file
with open('scripts/bell_state_qsharp.qs', 'r') as f:
    qs_code = f.read()

# In 2026, Q# can be JIT compiled directly from the string
qsharp.eval(qs_code)

# Run the entry point
results = qsharp.run("Main()", shots=1000)
print(f"Q# Execution Results: {results}")
