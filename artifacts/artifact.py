def get_primes(n):
    """获取 1 到 n 之间的所有质数"""
    primes = []
    for num in range(2, n + 1):  # 质数从 2 开始
        is_prime = True
        # 只需要检查到 num 的平方根即可，提高效率
        for i in range(2, int(num**0.5) + 1):
            if num % i == 0:
                is_prime = False
                break
        if is_prime:
            primes.append(num)
    return primes

# 输出 1 到 100 的质数
result = get_primes(100)
print(f"1 到 100 之间的质数共有 {len(result)} 个：")
print(result)